import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  MAP_DEMO_BUDGET,
  MAP_DEMO_MEDIA,
  MEDIA_DIR,
  mediaHoldsVideo,
  SCRIPTED_SCRIPT,
  scriptedDirProblems,
  scriptedPageProblems,
  scriptedPolicy,
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

// The site's pages with script (ADR 0050): the board at / and the map demo
// at /map/, each shaped as staticIndexHtml writes it.
const STYLE = '\n      body { margin: 0; }\n    ';
const styleHash = createHash('sha256').update(STYLE, 'utf8').digest('base64');

function scripted(worker: boolean, body: string, style = STYLE, video = false): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${scriptedPolicy(styleHash, worker, video)}" />
    <meta name="referrer" content="no-referrer" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>T</title>
    <style>${style}</style>
  </head>
  <body>
    ${body}
    <!-- Relative, so a copy served under <user>.github.io/<repository>/ finds its script too. -->
    ${SCRIPTED_SCRIPT}
  </body>
</html>
`;
}

const board = scripted(true, '<nav><a href="tour/">The tour</a> <a href="map/">The map</a></nav>');
const map = scripted(
  false,
  '<nav><a href="../">The board</a> <a href="../guide/16-map-pages.html">Map pages</a></nav><canvas aria-label="Map; drag to pan, or use the buttons"></canvas><video controls preload="none" poster="media/poster.png" width="1280" height="720"><source src="media/map-demo.mp4" type="video/mp4"><source src="media/map-demo.webm" type="video/webm"></video><a href="media/map-demo.mp4">The MP4</a>',
  STYLE,
  true,
);
/** The map demo plays its recording, so its policy takes media-src 'self'. */
const MAP_PAGE = { worker: false, video: true } as const;

describe('scriptedPageProblems (ADR 0050)', () => {
  it("passes the board's page and the map demo's, each under its own policy", () => {
    assert.deepEqual(scriptedPageProblems(board, { worker: true }), []);
    assert.deepEqual(scriptedPageProblems(map, MAP_PAGE), []);
    // The board's static policy, word for word (apps/demo/scripts/server.ts), and the map's
    // with worker-src 'none', since without it a worker falls back to script-src 'self',
    // and media-src 'self' for the recording it plays.
    assert.equal(
      scriptedPolicy('H', true),
      "default-src 'none'; script-src 'self'; style-src 'self' 'sha256-H'; img-src 'self'; connect-src wss: ws:; worker-src blob:; base-uri 'none'; form-action 'none'",
    );
    assert.equal(
      scriptedPolicy('H', false),
      "default-src 'none'; script-src 'self'; style-src 'self' 'sha256-H'; img-src 'self'; connect-src wss: ws:; worker-src 'none'; base-uri 'none'; form-action 'none'",
    );
    assert.equal(
      scriptedPolicy('H', false, true),
      "default-src 'none'; script-src 'self'; style-src 'self' 'sha256-H'; img-src 'self'; media-src 'self'; connect-src wss: ws:; worker-src 'none'; base-uri 'none'; form-action 'none'",
    );
  });

  it('refuses a page without its policy, with it twice, after what it governs, or looser than the rule', () => {
    const meta =
      /\s*<meta http-equiv="Content-Security-Policy" content="[^"]*" \/>/.exec(map)?.[0] ?? '';
    assert.ok(meta.length > 0);
    const has = (html: string, problem: string, worker = false, video = !worker): void => {
      assert.ok(scriptedPageProblems(html, { worker, video }).includes(problem), problem);
    };
    const mapRefused =
      "its policy is not the site's for a page with script and no worker, playing a video";
    has(map.replace(meta, ''), 'lacks its policy, or holds it more than once');
    has(map.replace(meta, `${meta}${meta}`), 'lacks its policy, or holds it more than once');
    has(
      map.replace(meta, '').replace('</style>', `</style>${meta}`),
      'has <style ahead of its policy',
    );
    // The board's worker on the map, or none on the board, is not the page's policy.
    has(map, "its policy is not the site's for a page with script and a worker", true, false);
    has(board, "its policy is not the site's for a page with script and no worker", false, false);
    has(map.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"), mapRefused);
    // The map without worker-src at all lets a same-origin script run as a worker.
    has(map.replace(" worker-src 'none';", ''), mapRefused);
    // Media from anywhere, or a page that plays no video yet takes media-src.
    has(map.replace("media-src 'self'", 'media-src *'), mapRefused);
    has(map, "its policy is not the site's for a page with script and no worker", false, false);
    // A style edited after its hash was taken.
    has(
      scripted(false, '', `${STYLE}p{}`, true).replace(/sha256-[^']+/, `sha256-${styleHash}`),
      mapRefused,
    );
    has(
      map.replace('<meta name="referrer" content="no-referrer" />', ''),
      'lacks the no-referrer meta',
    );
    has(
      map.replace(
        '<title>',
        '<meta http-equiv="refresh" content="0;url=https://evil.example"><title>',
      ),
      'holds another http-equiv meta',
    );
  });

  it('refuses an inline script, any script but its bundle, and anything that runs or loads besides', () => {
    const script = 'loads other than its one bundle, ./main.js, or holds an inline script';
    for (const [extra, problem] of [
      ['<script>alert(1)</script>', script],
      ['<SCRIPT type="module" src="./other.js"></SCRIPT>', script],
      ['<script src="https://cdn.example/x.js"></script>', script],
      ['<img src="x.png" onerror="alert(1)">', 'holds an on* event handler attribute'],
      ['<button/onclick="x">b</button>', 'holds an on* event handler attribute'],
      ['<p style="color:red">x</p>', 'holds a style attribute'],
      ['<iframe src="x.html"></iframe>', 'holds a <iframe> element'],
      ['<form action="x"></form>', 'holds a <form> element'],
      ['<base href="../">', 'holds a <base> element'],
      ['<link rel="stylesheet" href="x.css">', 'holds a <link> element'],
      [
        '<a href="https://evil.example/">x</a>',
        'names a URL outside the site, or from its root: https://evil.example/',
      ],
      [
        '<a href="//evil.example/">x</a>',
        'names a URL outside the site, or from its root: //evil.example/',
      ],
      ['<a href="/x">x</a>', 'names a URL outside the site, or from its root: /x'],
      [
        '<a href="javascript&#58;alert(1)">x</a>',
        'names a URL outside the site, or from its root: javascript&#58;alert(1)',
      ],
      ["<a href='x.html'>x</a>", 'has an unquoted or single-quoted href'],
      // Every attribute a browser loads, follows or sends to, not href and src alone.
      [
        '<img srcset="ok.png 1x, https://x.example/a.png 2x">',
        'names a URL outside the site, or from its root: ok.png 1x, https://x.example/a.png 2x',
      ],
      [
        '<video poster="https://x.example/p.png"></video>',
        'names a URL outside the site, or from its root: https://x.example/p.png',
      ],
      [
        '<button formaction="//x.example/">b</button>',
        'names a URL outside the site, or from its root: //x.example/',
      ],
      [
        '<a href="#x" ping="https://x.example/p">x</a>',
        'names a URL outside the site, or from its root: https://x.example/p',
      ],
      [
        '<img srcset="a.png&#44;https://x.example/b.png">',
        'names a URL outside the site, or from its root: a.png&#44;https://x.example/b.png',
      ],
      // A second URL in one tag, and one after a > inside a quoted value, are read too.
      [
        '<img src="ok.png" poster="/p.png">',
        'names a URL outside the site, or from its root: /p.png',
      ],
      [
        '<a title="a>b" href="https://x.example/">x</a>',
        'names a URL outside the site, or from its root: https://x.example/',
      ],
      ['<img srcset=a.png>', 'has an unquoted or single-quoted srcset'],
      ["<video poster='p.png'></video>", 'has an unquoted or single-quoted poster'],
    ] as const) {
      const html = map.replace('<canvas', `${extra}<canvas`);
      assert.ok(scriptedPageProblems(html, MAP_PAGE).includes(problem), extra);
    }
  });
});

/** The first bytes of a PNG, an MP4 and a WebM, as the media check reads them. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom')]);
const WEBM = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]),
  Buffer.from('webm'),
]);

describe('scriptedDirProblems, the read-back of the board and the map demo', () => {
  /** A built site: the board at its root with the tour and guide beside it, and the map demo at map/. */
  function site(): string {
    const dir = mkdtempSync(join(tmpdir(), 'tabdock-site-scripted-'));
    for (const sub of ['tour', 'guide', 'map', 'map/media']) mkdirSync(join(dir, sub));
    writeFileSync(join(dir, 'map', 'media', 'poster.png'), PNG);
    writeFileSync(join(dir, 'map', 'media', 'map-demo.mp4'), MP4);
    writeFileSync(join(dir, 'map', 'media', 'map-demo.webm'), WEBM);
    writeFileSync(join(dir, 'index.html'), board);
    writeFileSync(join(dir, 'tour', 'index.html'), good);
    writeFileSync(join(dir, 'guide', '16-map-pages.html'), good);
    writeFileSync(join(dir, 'map', 'index.html'), map);
    for (const at of ['', 'map']) {
      writeFileSync(
        join(dir, at, 'main.js'),
        'document.title;\n//# sourceMappingURL=main.js.map\n',
      );
      writeFileSync(join(dir, at, 'main.js.map'), '{}');
    }
    return dir;
  }
  const ROOT = { worker: true, subdirs: ['tour', 'guide', 'map'], links: ['map/'] };
  const MAP = {
    worker: false,
    subdirs: [MEDIA_DIR],
    budget: MAP_DEMO_BUDGET,
    media: MAP_DEMO_MEDIA,
    links: ['media/map-demo.mp4', 'media/map-demo.webm', 'media/poster.png'],
  };

  it("passes the site's own shape, with ADR 0050's budget and its recording's", async () => {
    assert.deepEqual(MAP_DEMO_BUDGET, { indexHtml: 16_000, mainJs: 800_000, mainJsGzip: 200_000 });
    assert.deepEqual(MAP_DEMO_MEDIA, {
      'poster.png': { kind: 'png', maxBytes: 300_000 },
      'map-demo.mp4': { kind: 'mp4', maxBytes: 4_000_000 },
      'map-demo.webm': { kind: 'webm', maxBytes: 4_000_000 },
    });
    assert.equal(mediaHoldsVideo(MAP_DEMO_MEDIA), true);
    assert.equal(mediaHoldsVideo({ 'poster.png': { kind: 'png', maxBytes: 1 } }), false);
    assert.equal(mediaHoldsVideo(undefined), false);
    const dir = site();
    try {
      assert.deepEqual(await scriptedDirProblems(dir, '', ROOT), []);
      assert.deepEqual(await scriptedDirProblems(dir, 'map', MAP), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names an extra file, a missing one, a test hook, a link to nowhere and a missing link to the map', async () => {
    const dir = site();
    try {
      writeFileSync(join(dir, 'map', 'extra.js'), 'alert(1)');
      mkdirSync(join(dir, 'map', 'tiles'));
      symlinkSync('/etc/hostname', join(dir, 'map', 'world.png'));
      rmSync(join(dir, 'map', 'main.js.map'));
      writeFileSync(join(dir, 'main.js'), 'window.__tabdockDock = dock;');
      rmSync(join(dir, 'guide', '16-map-pages.html'));
      writeFileSync(join(dir, 'index.html'), board.replace('<a href="map/">The map</a>', ''));
      assert.deepEqual(await scriptedDirProblems(dir, 'map', MAP), [
        'map/extra.js: has no place beside a page with script',
        'map/index.html: links ../guide/16-map-pages.html, which the site does not hold',
        'map/main.js.map: is missing',
        'map/tiles/: has no place beside a page with script',
        'map/world.png: is neither a file nor a directory',
      ]);
      assert.deepEqual(await scriptedDirProblems(dir, '', ROOT), [
        'index.html: does not link map/',
        'main.js: holds a test hook',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holds the map demo's media to its three files, each of its kind and within its budget", async () => {
    const dir = site();
    try {
      const media = join(dir, 'map', 'media');
      writeFileSync(join(media, 'poster.png'), '<script>alert(1)</script>');
      writeFileSync(join(media, 'map-demo.mp4'), WEBM);
      writeFileSync(
        join(media, 'map-demo.webm'),
        Buffer.concat([WEBM, Buffer.alloc(4_000_001 - WEBM.length)]),
      );
      writeFileSync(join(media, 'page.html'), '<script>alert(1)</script>');
      // The README's loop lives in the source tree's media/, never beside the page.
      writeFileSync(join(media, 'map-demo-loop.gif'), 'GIF89a');
      symlinkSync('/etc/hostname', join(media, 'constructor'));
      assert.deepEqual(await scriptedDirProblems(dir, 'map', MAP), [
        'map/media/constructor: is not a plain file',
        'map/media/map-demo-loop.gif: has no place beside a page with script',
        'map/media/map-demo.mp4: is not an MP4 file',
        'map/media/map-demo.webm: 4,000,001 bytes, over its budget of 4,000,000',
        'map/media/page.html: has no place beside a page with script',
        'map/media/poster.png: is not a PNG file',
      ]);
      // A missing poster: the page's link to it leads nowhere, and the page must carry it.
      rmSync(join(media, 'poster.png'));
      writeFileSync(join(dir, 'map', 'index.html'), map.replace(' poster="media/poster.png"', ''));
      const problems = await scriptedDirProblems(dir, 'map', MAP);
      assert.ok(problems.includes('map/media/poster.png: is missing'), problems.join('\n'));
      assert.ok(problems.includes('map/index.html: does not link media/poster.png'));
      // The board, which lists no media, ships none.
      mkdirSync(join(dir, MEDIA_DIR));
      assert.deepEqual(await scriptedDirProblems(dir, '', ROOT), [
        'media/: has no place beside a page with script',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a page with script holding a bad page, or a bundle over budget', async () => {
    const dir = site();
    try {
      writeFileSync(
        join(dir, 'map', 'index.html'),
        map.replace('<canvas', '<script>alert(1)</script><canvas'),
      );
      // Bytes that do not compress, one over the budget either way.
      writeFileSync(join(dir, 'map', 'main.js'), randomBytes(MAP_DEMO_BUDGET.mainJs + 1));
      const problems = await scriptedDirProblems(dir, 'map', MAP);
      assert.equal(problems.length, 3, problems.join('\n'));
      assert.ok(
        problems.includes(
          'map/index.html: loads other than its one bundle, ./main.js, or holds an inline script',
        ),
      );
      assert.ok(problems.includes('map/main.js: 800,001 bytes, over its budget of 800,000'));
      assert.ok(
        problems.some((line) =>
          /^map\/main\.js: [\d,]+ bytes gzipped, over its budget of 200,000$/.test(line),
        ),
      );
      // An index.html past its own budget, though every byte is a rule-abiding comment.
      writeFileSync(
        join(dir, 'map', 'index.html'),
        map.replace('<body>', `<body><!--${'x'.repeat(16_000)}-->`),
      );
      writeFileSync(join(dir, 'map', 'main.js'), 'ok');
      assert.deepEqual(await scriptedDirProblems(dir, 'map', MAP), [
        `map/index.html: ${(Buffer.byteLength(map) + 16_007).toLocaleString('en')} bytes, over its budget of 16,000`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

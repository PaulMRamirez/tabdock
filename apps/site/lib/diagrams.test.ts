// Draws real diagrams in the build's Chromium, as `pnpm site:build` does.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { svgProblems } from './checks.ts';
import { drawDiagrams } from './diagrams.ts';

describe('drawDiagrams (ADR 0029)', () => {
  it('draws flowcharts and sequence diagrams as plain pictures that pass the SVG checks', async () => {
    const svgs = await drawDiagrams([
      'flowchart TB\n  C[Claude] -->|MCP| R[relay]\n  R --> P[page]',
      'sequenceDiagram\n  participant A as adapter\n  A->>A: hash matches\n  A-->>B: result',
    ]);
    assert.equal(svgs.length, 2);
    for (const svg of svgs) {
      assert.deepEqual(svgProblems(svg), []);
      assert.match(svg, /^<svg [^>]*width="\d+"[^>]*>/);
      assert.doesNotMatch(svg, /foreignObject/);
    }
  });

  it('keeps markup in labels as text, under the strict security level', async () => {
    const [svg = '', withSrc = ''] = await drawDiagrams([
      'flowchart LR\n  A["<script>alert(1)</script>"] --> B["<b onmouseover=alert(1)>x</b>"]',
      'flowchart LR\n  A["<img src=x>"] --> B',
    ]);
    assert.deepEqual(svgProblems(svg), []);
    assert.doesNotMatch(svg, /<script|<b\b|<img/i);
    // The attribute scan reads text too, so a label that only looks like one stops the build: it errs towards refusing.
    assert.deepEqual(svgProblems(withSrc), ['src names x, outside the diagram']);
  });

  it('keeps a click link, which strict mode still draws, for the checks to stop', async () => {
    const [svg = ''] = await drawDiagrams([
      'flowchart LR\n  A --> B\n  click A href "https://evil.example/" _blank',
    ]);
    assert.ok(svgProblems(svg).some((problem) => problem.includes('https://evil.example/')));
  });

  it('blocks a diagram that reaches for the network, and stops the build', async () => {
    // A server on this machine that would answer, to show the request never left the browser.
    let reached = 0;
    const server = createServer((_request, response) => {
      reached += 1;
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${String(address !== null && typeof address === 'object' ? address.port : 0)}/x.png`;
    try {
      await assert.rejects(
        drawDiagrams([`flowchart LR\n  A@{ img: "${url}", label: "x", pos: "t", w: 60, h: 60 }`]),
        (error: unknown) =>
          error instanceof Error && error.message.includes(`tried to reach the network: ${url}`),
      );
      assert.equal(reached, 0);
    } finally {
      server.close();
    }
  });
});

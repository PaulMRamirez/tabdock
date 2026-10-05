// Mermaid drawn to SVG at build time (ADR 0029), so tour pages need no
// script. Mermaid runs from its self-contained bundle in Playwright's
// Chromium, the browser CI already installs, with every request and socket
// refused: it reads only the repository's own text and reaches nothing. Its
// `strict` security level and `htmlLabels: false` keep labels as SVG text,
// with no HTML inside a <foreignObject>.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

/**
 * Runs in the page: draws one diagram and returns it as standalone XML with
 * a fixed width and height, since an <img> needs an intrinsic size and an
 * SVG serialised as HTML (a bare <br>, say) is no valid image.
 */
async function drawOne(input: { source: string; id: string }): Promise<string> {
  const mermaid = (window as unknown as { mermaid: MermaidApi }).mermaid;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    deterministicIds: true,
    deterministicIDSeed: input.id,
    theme: 'default',
  });
  const { svg } = await mermaid.render(input.id, input.source);
  const holder = document.createElement('div');
  holder.innerHTML = svg;
  const root = holder.querySelector('svg');
  if (root === null) throw new Error('Mermaid drew no <svg>');
  const box = root.viewBox.baseVal;
  root.setAttribute('width', String(Math.ceil(box.width)));
  root.setAttribute('height', String(Math.ceil(box.height)));
  // Mermaid's max-width style would shrink a wide diagram to its column; the page scrolls it instead.
  root.removeAttribute('style');
  return new XMLSerializer().serializeToString(root);
}

/** Runs in the page: each SVG's width once loaded as an image, or 0 where it will not load. */
async function imageWidths(svgs: string[]): Promise<number[]> {
  return Promise.all(
    svgs.map(
      (svg) =>
        new Promise<number>((resolve) => {
          const image = new Image();
          const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
          image.onload = () => {
            resolve(image.naturalWidth);
          };
          image.onerror = () => {
            resolve(0);
          };
          image.src = url;
        }),
    ),
  );
}

/** Draws each Mermaid source to an SVG document, in order. */
export async function drawDiagrams(sources: readonly string[]): Promise<string[]> {
  if (sources.length === 0) return [];
  const bundle = await readFile(
    fileURLToPath(import.meta.resolve('mermaid/dist/mermaid.min.js')),
    'utf8',
  );
  const executablePath = process.env.CHROMIUM_EXECUTABLE?.trim();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    const context = await browser.newContext({ offline: true, serviceWorkers: 'block' });
    const attempted: string[] = [];
    await context.route('**/*', async (route) => {
      attempted.push(route.request().url());
      await route.abort('blockedbyclient');
    });
    await context.routeWebSocket(/.*/, async (socket) => {
      attempted.push(socket.url());
      await socket.close();
    });
    const page = await context.newPage();
    await page.setContent(
      '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>',
    );
    await page.addScriptTag({ content: bundle });
    const reachedOut = (): Error =>
      new Error(`drawing the diagrams tried to reach the network: ${attempted.join(', ')}`);
    const svgs: string[] = [];
    for (const [index, source] of sources.entries()) {
      try {
        svgs.push(
          await page.evaluate(drawOne, { source, id: `tour-diagram-${String(index + 1)}` }),
        );
      } catch (error) {
        // A diagram that fetches something fails to draw once the fetch is refused; say why.
        if (attempted.length > 0) throw reachedOut();
        throw new Error(
          `diagram ${String(index + 1)} could not be drawn: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const widths = await page.evaluate(imageWidths, svgs);
    if (attempted.length > 0) throw reachedOut();
    widths.forEach((width, index) => {
      if (width <= 0) throw new Error(`diagram ${String(index + 1)} does not load as an image`);
    });
    return svgs;
  } finally {
    await browser.close();
  }
}

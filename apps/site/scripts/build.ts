// pnpm site:build (ADR 0029): writes the GitHub Pages site into
// apps/site/dist, the demo's own static build at the root and docs/tour at
// /tour/, then reads back every tour page and diagram it wrote and stops on
// any that holds a script, an event handler or an outside URL, or lacks the
// tour policy. Pages publishes one directory per deploy, so the site is
// always built whole: a tour-only publish would drop the demo.

import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { buildDemo } from '../../demo/scripts/server.ts';
import { COPIED_IMAGES, tourDirProblems } from '../lib/checks.ts';
import { drawDiagrams } from '../lib/diagrams.ts';
import { TOUR_DIR } from '../lib/links.ts';
import { type RenderedPage, renderTourPage } from '../lib/markdown.ts';
import { indexPage, type PageLink, tourPage } from '../lib/page.ts';
import { resolveRepository } from '../lib/repo.ts';

const siteDir = resolve(import.meta.dirname, '..');
const repoRoot = resolve(siteDir, '../..');
const tourSource = join(repoRoot, TOUR_DIR);
const distDir = join(siteDir, 'dist');
const tourOut = join(distDir, 'tour');
const imageOut = join(tourOut, 'img');

async function main(): Promise<void> {
  const repository = resolveRepository(repoRoot);

  // The demo first: buildDemo empties dist, then the tour goes in beside it.
  await buildDemo({ outDir: distDir });
  const demoIndex = await readFile(join(distDir, 'index.html'), 'utf8');
  if (
    !demoIndex.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none';`)
  ) {
    throw new Error("the demo's index.html lacks its policy");
  }

  const names = (await readdir(tourSource)).filter((name) => name.endsWith('.md')).sort();
  const stems = names.map((name) => name.slice(0, -'.md'.length));
  for (const stem of stems) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(stem))
      throw new Error(`${TOUR_DIR}/${stem}.md: name the file in lower case, digits and hyphens`);
  }
  const tourPages = new Set(stems);
  const rendered: { stem: string; page: RenderedPage }[] = [];
  for (const stem of stems) {
    const markdown = await readFile(join(tourSource, `${stem}.md`), 'utf8');
    try {
      rendered.push({ stem, page: renderTourPage(markdown, stem, { repository, tourPages }) });
    } catch (error) {
      throw new Error(
        `${TOUR_DIR}/${stem}.md: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  await mkdir(imageOut, { recursive: true });
  const diagrams = rendered.flatMap(({ page }) => page.diagrams);
  const svgs = await drawDiagrams(diagrams.map((diagram) => diagram.source));
  for (const [index, diagram] of diagrams.entries()) {
    await writeFile(join(imageOut, diagram.file), svgs[index] ?? '');
  }
  // Raster images only: an SVG of the tour's own could carry script, and the
  // drawn diagrams' names end in .svg, so neither can overwrite the other.
  for (const name of await readdir(join(tourSource, 'img'))) {
    if (!COPIED_IMAGES.has(extname(name).toLowerCase())) {
      throw new Error(`${TOUR_DIR}/img/${name}: the tour copies only raster images`);
    }
    await copyFile(join(tourSource, 'img', name), join(imageOut, name));
  }

  const links: PageLink[] = rendered.map(({ stem, page }) => ({
    href: `${stem}.html`,
    title: page.title,
  }));
  for (const [index, { stem, page }] of rendered.entries()) {
    const html = tourPage({
      title: page.title,
      body: page.body,
      previous: links[index - 1] ?? null,
      next: links[index + 1] ?? null,
      repository,
    });
    await writeFile(join(tourOut, `${stem}.html`), html);
  }
  await writeFile(join(tourOut, 'index.html'), indexPage(links, repository));
  await copyFile(join(siteDir, 'assets/tour.css'), join(tourOut, 'tour.css'));

  // Read back from disk, so what passes is what Pages serves.
  const problems = await tourDirProblems(tourOut);
  if (problems.length > 0) {
    throw new Error(
      `the tour may not ship:\n${problems.map((line) => `  tour/${line}`).join('\n')}`,
    );
  }
  console.log(
    `Built the site into ${distDir}: the demo at /, ${String(rendered.length)} tour pages and ${String(diagrams.length)} diagrams at /tour/, from ${repository.commit.slice(0, 7)}.`,
  );
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `site build failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

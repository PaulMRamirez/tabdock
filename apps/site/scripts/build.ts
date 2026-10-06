// pnpm site:build (ADRs 0029 and 0035): writes the GitHub Pages site into
// apps/site/dist, the demo's own static build at the root, docs/tour at
// /tour/ and docs/guide at /guide/, then reads back every page and diagram it
// wrote and stops on any that holds a script, an event handler or an outside
// URL, or lacks the site policy. The guide is held to exactly the tour's
// rules. Pages publishes one directory per deploy, so the site is always
// built whole: a tour-only publish would drop the demo. It also draws the
// README's diagrams, which it does not publish, and stops on one that will
// not draw, so A5.5's "the README builds" has a check of its own.

import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { buildDemo } from '../../demo/scripts/server.ts';
import { COPIED_IMAGES, tourDirProblems } from '../lib/checks.ts';
import { drawDiagrams } from '../lib/diagrams.ts';
import { type Collection, GUIDE_DIR, type Repository, TOUR_DIR } from '../lib/links.ts';
import { mermaidSources, type RenderedPage, renderPage } from '../lib/markdown.ts';
import {
  collectionPage,
  guideIndexPage,
  indexPage,
  type PageLink,
  type Section,
} from '../lib/page.ts';
import { resolveRepository } from '../lib/repo.ts';

const siteDir = resolve(import.meta.dirname, '..');
const repoRoot = resolve(siteDir, '../..');
const distDir = join(siteDir, 'dist');

/** What the site publishes from docs/: each collection's source, its place, and its index's source. */
const SOURCES: readonly { dir: string; out: Section; indexStem?: string }[] = [
  { dir: TOUR_DIR, out: 'tour' },
  { dir: GUIDE_DIR, out: 'guide', indexStem: 'README' },
];

interface Built {
  collection: Collection;
  out: Section;
  rendered: { stem: string; page: RenderedPage }[];
  index: RenderedPage | null;
}

/** A collection's page stems from its directory, each held to the site's file names. */
async function stemsIn(dir: string): Promise<string[]> {
  const names = (await readdir(join(repoRoot, dir))).filter((name) => name.endsWith('.md')).sort();
  const stems = names.map((name) => name.slice(0, -'.md'.length));
  for (const stem of stems) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(stem) && stem !== 'README') {
      throw new Error(`${dir}/${stem}.md: name the file in lower case, digits and hyphens`);
    }
  }
  return stems;
}

function render(
  markdown: string,
  stem: string,
  context: Parameters<typeof renderPage>[2],
): RenderedPage {
  try {
    return renderPage(markdown, stem, context);
  } catch (error) {
    throw new Error(
      `${context.collection.dir}/${stem}.md: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Renders every collection, so a link from either to any page of both resolves or stops the build. */
async function renderAll(repository: Repository): Promise<Built[]> {
  const listed = await Promise.all(
    SOURCES.map(async (source) => {
      const stems = await stemsIn(source.dir);
      if (source.indexStem !== undefined && !stems.includes(source.indexStem)) {
        throw new Error(`${source.dir}/${source.indexStem}.md: the index page is missing`);
      }
      const collection: Collection = {
        dir: source.dir,
        out: source.out,
        indexStem: source.indexStem,
        pages: new Set(stems.filter((stem) => stem !== source.indexStem)),
      };
      return { source, collection };
    }),
  );
  const collections = listed.map(({ collection }) => collection);
  const built: Built[] = [];
  for (const { source, collection } of listed) {
    const context = { repository, collection, collections };
    const rendered: { stem: string; page: RenderedPage }[] = [];
    for (const stem of collection.pages) {
      const markdown = await readFile(join(repoRoot, source.dir, `${stem}.md`), 'utf8');
      rendered.push({ stem, page: render(markdown, stem, context) });
    }
    const index =
      source.indexStem === undefined
        ? null
        : render(
            await readFile(join(repoRoot, source.dir, `${source.indexStem}.md`), 'utf8'),
            source.indexStem,
            context,
          );
    built.push({ collection, out: source.out, rendered, index });
  }
  return built;
}

/** Draws a collection's diagrams and copies its raster images into its img/. */
async function writeImages(built: Built, outDir: string): Promise<number> {
  const imageOut = join(outDir, 'img');
  await mkdir(imageOut, { recursive: true });
  const pages = [...built.rendered.map(({ page }) => page), ...(built.index ? [built.index] : [])];
  const diagrams = pages.flatMap((page) => page.diagrams);
  const svgs = await drawDiagrams(diagrams.map((diagram) => diagram.source));
  for (const [index, diagram] of diagrams.entries()) {
    await writeFile(join(imageOut, diagram.file), svgs[index] ?? '');
  }
  // Raster images only: an SVG of the collection's own could carry script, and
  // the drawn diagrams' names end in .svg, so neither can overwrite the other.
  const imageSource = join(repoRoot, built.collection.dir, 'img');
  if (existsSync(imageSource)) {
    for (const name of await readdir(imageSource)) {
      if (!COPIED_IMAGES.has(extname(name).toLowerCase())) {
        throw new Error(`${built.collection.dir}/img/${name}: the site copies only raster images`);
      }
      await copyFile(join(imageSource, name), join(imageOut, name));
    }
  }
  return diagrams.length;
}

/** Writes a collection's pages, its index and its stylesheet into dist/<out>. */
async function writePages(built: Built, outDir: string, repository: Repository): Promise<void> {
  const links: PageLink[] = built.rendered.map(({ stem, page }) => ({
    href: `${stem}.html`,
    title: page.title,
  }));
  for (const [index, { stem, page }] of built.rendered.entries()) {
    const html = collectionPage(built.out, {
      title: page.title,
      body: page.body,
      previous: links[index - 1] ?? null,
      next: links[index + 1] ?? null,
      repository,
    });
    await writeFile(join(outDir, `${stem}.html`), html);
  }
  if (built.index === null) {
    await writeFile(join(outDir, 'index.html'), indexPage(links, repository));
  } else {
    // The index is the reader's way in, so it must reach every page.
    const unlinked = links.filter((link) => !built.index?.body.includes(`href="${link.href}`));
    if (unlinked.length > 0) {
      throw new Error(
        `${built.collection.dir}/${built.collection.indexStem ?? ''}.md does not link ${unlinked.map((link) => link.href).join(', ')}`,
      );
    }
    await writeFile(
      join(outDir, 'index.html'),
      guideIndexPage({ title: built.index.title, body: built.index.body, repository }),
    );
  }
  await copyFile(join(siteDir, 'assets/tour.css'), join(outDir, 'tour.css'));
}

async function main(): Promise<void> {
  const repository = resolveRepository(repoRoot);

  // The demo first: buildDemo empties dist, then the tour and the guide go in beside it.
  await buildDemo({ outDir: distDir });
  const demoIndex = await readFile(join(distDir, 'index.html'), 'utf8');
  if (
    !demoIndex.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none';`)
  ) {
    throw new Error("the demo's index.html lacks its policy");
  }

  const built = await renderAll(repository);

  // The README shows its architecture as Mermaid, which GitHub draws (ADR
  // 0029); one that will not draw here would show there as an error.
  const readmeDiagrams = mermaidSources(await readFile(join(repoRoot, 'README.md'), 'utf8'));
  if (readmeDiagrams.length === 0) throw new Error('README.md: no Mermaid diagram found');
  try {
    await drawDiagrams(readmeDiagrams);
  } catch (error) {
    throw new Error(`README.md: ${error instanceof Error ? error.message : String(error)}`);
  }

  const counts: string[] = [];
  for (const collection of built) {
    const outDir = join(distDir, collection.out);
    const diagrams = await writeImages(collection, outDir);
    await writePages(collection, outDir, repository);
    // Read back from disk, so what passes is what Pages serves.
    const problems = await tourDirProblems(outDir);
    if (problems.length > 0) {
      throw new Error(
        `the ${collection.out} may not ship:\n${problems.map((line) => `  ${collection.out}/${line}`).join('\n')}`,
      );
    }
    counts.push(
      `${String(collection.rendered.length)} ${collection.out} pages and ${String(diagrams)} diagrams at /${collection.out}/`,
    );
  }
  console.log(
    `Built the site into ${distDir}: the demo at /, ${counts.join(', ')}, from ${repository.commit.slice(0, 7)}, and drew the README's ${String(readmeDiagrams.length)} (not published).`,
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

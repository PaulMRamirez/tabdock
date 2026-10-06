// The HTML around each page of the tour and the guide, and their indexes.
// Every page opens its <head> with the site policy and a no-referrer meta,
// loads its collection's copy of tour.css and nothing else, and links to the
// guide, the tour and the demo board at the site's root by relative paths,
// so the site works on a custom domain and under
// <user>.github.io/<repository>/ alike. The guide and the tour are held to
// the same checks (ADR 0035), so they share this one shell.

import { NO_REFERRER_META, TOUR_POLICY_META } from './checks.ts';
import type { Repository } from './links.ts';
import { escapeHtml } from './markdown.ts';

export interface PageLink {
  href: string;
  title: string;
}

/** The site's two collections of pages, by their directory on the site. */
export type Section = 'tour' | 'guide';

const SECTION_NAMES: Readonly<Record<Section, string>> = {
  guide: 'Tabdock guide',
  tour: 'Tabdock tour',
};

/** The header's links, each relative to a page of `section`. */
function nav(section: Section): string {
  const to = (target: Section): string =>
    target === section ? 'index.html' : `../${target}/index.html`;
  return `<nav><a href="${to('guide')}">The guide</a> <a href="${to('tour')}">The tour</a> <a href="../">The demo board</a></nav>`;
}

function shell(section: Section, title: string, main: string, footer: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${TOUR_POLICY_META}
${NO_REFERRER_META}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="tour.css">
</head>
<body>
<header>${nav(section)}</header>
<main>
${main}</main>
<footer>
${footer}</footer>
</body>
</html>
`;
}

function builtFrom(repository: Repository): string {
  const short = repository.commit.slice(0, 7);
  return `<p>Built from <a href="${escapeHtml(`${repository.web}/tree/${repository.commit}`)}">commit ${short}</a>. Apache-2.0.</p>\n`;
}

export interface PageOptions {
  title: string;
  body: string;
  previous: PageLink | null;
  next: PageLink | null;
  repository: Repository;
}

/** One page of a collection, with its previous and next pages in the footer. */
export function collectionPage(section: Section, options: PageOptions): string {
  const steps = [
    options.previous
      ? `<a rel="prev" href="${escapeHtml(options.previous.href)}">Previous: ${escapeHtml(options.previous.title)}</a>`
      : '',
    options.next
      ? `<a rel="next" href="${escapeHtml(options.next.href)}">Next: ${escapeHtml(options.next.title)}</a>`
      : '',
  ].filter((step) => step !== '');
  const footer = `${steps.length > 0 ? `<nav class="steps">${steps.join(' ')}</nav>\n` : ''}${builtFrom(options.repository)}`;
  return shell(section, `${options.title} · ${SECTION_NAMES[section]}`, options.body, footer);
}

export function tourPage(options: PageOptions): string {
  return collectionPage('tour', options);
}

export function guidePage(options: PageOptions): string {
  return collectionPage('guide', options);
}

export function indexPage(pages: readonly PageLink[], repository: Repository): string {
  const items = pages
    .map((page) => `<li><a href="${escapeHtml(page.href)}">${escapeHtml(page.title)}</a></li>`)
    .join('\n');
  const main = `<h1>The Tabdock tour</h1>
<p>Tabdock lets MCP clients attach to a live web page through one stable relay URL, with the person at the tab approving each client. Each milestone ships one short page here: what was built, one request traced from start to finish with pointers into the code, and three things to try by hand. The tour is the history of the build; to use Tabdock in your own app, with your own clients or on your own relay, read <a href="../guide/index.html">the guide</a>.</p>
<ol class="pages">
${items}
</ol>
<p>The <a href="../">demo board</a> beside this tour is the page the explainers attach to. It dials a relay only after you choose one and click to connect.</p>
`;
  return shell('tour', 'The Tabdock tour', main, builtFrom(repository));
}

/**
 * The guide's index: its README rendered, which says who the guide is for,
 * that the tour is the build's history, and lists every page in order.
 */
export function guideIndexPage(options: {
  title: string;
  body: string;
  repository: Repository;
}): string {
  return shell('guide', options.title, options.body, builtFrom(options.repository));
}

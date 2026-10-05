// The HTML around each tour page and the tour's index. Every page opens its
// <head> with the tour policy and a no-referrer meta, loads tour.css and
// nothing else, and links back to the demo board at the site's root by a
// relative path, so the site works on a custom domain and under
// <user>.github.io/<repository>/ alike.

import { NO_REFERRER_META, TOUR_POLICY_META } from './checks.ts';
import type { Repository } from './links.ts';
import { escapeHtml } from './markdown.ts';

export interface PageLink {
  href: string;
  title: string;
}

function shell(title: string, main: string, footer: string): string {
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
<header><nav><a href="index.html">The tour</a> <a href="../">The demo board</a></nav></header>
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

export function tourPage(options: {
  title: string;
  body: string;
  previous: PageLink | null;
  next: PageLink | null;
  repository: Repository;
}): string {
  const steps = [
    options.previous
      ? `<a rel="prev" href="${escapeHtml(options.previous.href)}">Previous: ${escapeHtml(options.previous.title)}</a>`
      : '',
    options.next
      ? `<a rel="next" href="${escapeHtml(options.next.href)}">Next: ${escapeHtml(options.next.title)}</a>`
      : '',
  ].filter((step) => step !== '');
  const footer = `${steps.length > 0 ? `<nav class="steps">${steps.join(' ')}</nav>\n` : ''}${builtFrom(options.repository)}`;
  return shell(`${options.title} · Tabdock tour`, options.body, footer);
}

export function indexPage(pages: readonly PageLink[], repository: Repository): string {
  const items = pages
    .map((page) => `<li><a href="${escapeHtml(page.href)}">${escapeHtml(page.title)}</a></li>`)
    .join('\n');
  const main = `<h1>The Tabdock tour</h1>
<p>Tabdock lets MCP clients attach to a live web page through one stable relay URL, with the person at the tab approving each client. Each milestone ships one short page here: what was built, one request traced from start to finish with pointers into the code, and three things to try by hand.</p>
<ol class="pages">
${items}
</ol>
<p>The <a href="../">demo board</a> beside this tour is the page the explainers attach to. It dials a relay only after you choose one and click to connect.</p>
`;
  return shell('The Tabdock tour', main, builtFrom(repository));
}

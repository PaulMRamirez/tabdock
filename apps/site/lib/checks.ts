// What the build refuses to ship (ADR 0029). Tour pages share an origin with
// the demo board, which the relay's allowlist vouches for and whose tab keeps
// the adapter's records in sessionStorage, so a tour page must hold no script
// of any kind and run under its policy, and every diagram must be a plain
// picture that names nothing outside the site. These checks read the files as
// written to dist, so what they pass is what Pages serves. Guide pages share
// the same origin and get the same checks, word for word (ADR 0035): the
// names say tour because the tour came first, and every rule holds site-wide.
// The site's two pages with script, the board at / and the map demo at /map/
// (ADR 0050), are read back too, against the board's static rules restated
// here, so a loosened build stops the site rather than ships.

import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, posix, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

/** The pictures the tour copies from docs/tour/img; an SVG of its own could carry script. */
export const COPIED_IMAGES: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
]);

/** All the tour may hold: its pages, its one stylesheet, drawn diagrams and copied pictures. */
const SHIPPED: ReadonlySet<string> = new Set(['.html', '.css', '.svg', ...COPIED_IMAGES]);

/** Every tour page's policy, in a <meta> element ahead of anything it governs. */
export const TOUR_POLICY =
  "default-src 'none'; img-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'";

export const TOUR_POLICY_META = `<meta http-equiv="Content-Security-Policy" content="${TOUR_POLICY}">`;
export const NO_REFERRER_META = '<meta name="referrer" content="no-referrer">';

/** An event handler attribute inside a tag; text never holds a raw < (it is escaped), so a < starts a tag. */
const ON_ATTRIBUTE = /<[a-z][^>]*?[\s/"']on[a-z]+\s*=/i;

/** Character references a browser decodes in an attribute before it reads a URL. */
function decodeReferences(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&colon;/gi, ':')
    .replace(/&tab;|&newline;/gi, '');
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Why a tour page may not ship; empty when it may. */
export function tourPageProblems(html: string): string[] {
  const problems: string[] = [];
  if (/<script\b/i.test(html)) problems.push('holds a <script> element');
  if (ON_ATTRIBUTE.test(html)) problems.push('holds an on* event handler attribute');
  const policyAt = html.indexOf(TOUR_POLICY_META);
  if (count(html, TOUR_POLICY_META) !== 1) {
    problems.push('lacks the tour policy, or holds it more than once');
  } else {
    for (const later of ['<title', '<link', '<body', '<img']) {
      const at = html.indexOf(later);
      if (at !== -1 && at < policyAt) problems.push(`has ${later} ahead of its policy`);
    }
  }
  if (!html.includes(NO_REFERRER_META)) problems.push('lacks the no-referrer meta');
  if (count(html, '<meta http-equiv') !== 1) problems.push('holds another http-equiv meta');
  const forbidden =
    /<(iframe|frame|frameset|object|embed|applet|form|base|style|svg|math|template|portal|link(?![^>]*\brel="stylesheet"\s+href="tour\.css"))\b/i.exec(
      html,
    );
  if (forbidden) problems.push(`holds a <${forbidden[1]?.toLowerCase() ?? ''}> element`);
  if (/<[a-z][^>]*?[\s/"']style\s*=/i.test(html)) problems.push('holds a style attribute');
  for (const match of html.matchAll(
    /<[a-z][^>]*?[\s/"'](href|src|srcset|action|formaction)\s*=\s*(.)/gi,
  )) {
    if (match[2] !== '"') problems.push(`has an unquoted or single-quoted ${match[1] ?? ''}`);
  }
  for (const match of html.matchAll(/<([a-z]+)\b[^>]*?[\s/"'](href|src)="([^"]*)"/gi)) {
    const [, tag = '', attribute = '', raw = ''] = match;
    const value = decodeReferences(raw).replace(/[\s\u0000-\u001f]/g, '');
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
    if (attribute.toLowerCase() === 'src') {
      if (tag.toLowerCase() !== 'img') problems.push(`has a src on <${tag}>`);
      if (scheme !== undefined || value.startsWith('/') || value.startsWith('\\')) {
        problems.push(`shows an image from outside the site: ${raw}`);
      }
    } else if (scheme !== undefined && !['http', 'https', 'mailto'].includes(scheme)) {
      problems.push(`links to a ${scheme}: URL`);
    }
  }
  return problems;
}

/** The namespace declarations an SVG may name, which no browser fetches. */
const NAMESPACES =
  /\sxmlns(:[a-z]+)?="http:\/\/www\.w3\.org\/(2000\/svg|1999\/xlink|1999\/xhtml|XML\/1998\/namespace)"/g;

/** Why a diagram may not ship; empty when it may. */
export function svgProblems(svg: string): string[] {
  const problems: string[] = [];
  if (!/^<svg\b/.test(svg)) problems.push('does not start with <svg');
  if (/<script\b/i.test(svg)) problems.push('holds a <script> element');
  if (ON_ATTRIBUTE.test(svg)) problems.push('holds an on* event handler attribute');
  if (/<foreignObject\b/i.test(svg)) problems.push('holds a <foreignObject>, which carries HTML');
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(svg))
    problems.push('holds a DOCTYPE, entity or stylesheet instruction');
  if (/@import\b/i.test(svg)) problems.push('imports a stylesheet');
  for (const match of svg.matchAll(
    /[\s/"']((?:xlink:)?href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/gi,
  )) {
    const value = decodeReferences(match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (!value.startsWith('#'))
      problems.push(`${match[1] ?? ''} names ${value}, outside the diagram`);
  }
  for (const match of svg.matchAll(/url\(\s*(?:&quot;|["'])?\s*([^)"'&]*)/gi)) {
    const value = decodeReferences(match[1] ?? '').trim();
    if (!value.startsWith('#')) problems.push(`url(${value}) names something outside the diagram`);
  }
  const rest = svg.replace(NAMESPACES, '');
  const outside = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<)]*/i.exec(decodeReferences(rest));
  if (outside) problems.push(`names an outside URL: ${outside[0]}`);
  return problems;
}

/**
 * Reads back everything under the built tour directory and says why any of
 * it may not ship, each line naming its file relative to that directory: a
 * page or diagram failing the checks above, a file of a type the tour never
 * holds, or anything but a plain file or directory.
 */
export async function tourDirProblems(tourDir: string): Promise<string[]> {
  const problems: string[] = [];
  const entries = await readdir(tourDir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name);
    const shown = relative(tourDir, path);
    if (entry.isDirectory()) continue;
    if (!entry.isFile()) {
      problems.push(`${shown}: is neither a file nor a directory`);
      continue;
    }
    const type = extname(entry.name).toLowerCase();
    if (!SHIPPED.has(type)) {
      problems.push(`${shown}: a ${type || 'typeless'} file has no place in the tour`);
    }
    if (type === '.html') {
      for (const problem of tourPageProblems(await readFile(path, 'utf8'))) {
        problems.push(`${shown}: ${problem}`);
      }
    } else if (type === '.svg') {
      for (const problem of svgProblems(await readFile(path, 'utf8'))) {
        problems.push(`${shown}: ${problem}`);
      }
    }
  }
  return problems.sort();
}

/**
 * The policy of a page with script on the site: the board's static policy
 * (staticPolicy in apps/demo/scripts/server.ts, ADR 0029) restated, so the
 * read-back is a second opinion rather than an echo of the build. Scripts
 * from the site alone, styles from the page's one inline block by its hash,
 * sockets to whatever relay a visitor names, no base URL and no form posts.
 * worker-src blob: is the board's ?busy worker; the map demo starts none, so
 * its policy leaves it out (ADR 0050).
 */
export function scriptedPolicy(styleHash: string, worker: boolean): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    `style-src 'self' 'sha256-${styleHash}'`,
    "img-src 'self'",
    'connect-src wss: ws:',
    ...(worker ? ['worker-src blob:'] : []),
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** The one script a page with script loads: its own bundle, beside it, by a relative path. */
export const SCRIPTED_SCRIPT = '<script type="module" src="./main.js"></script>';

const SCRIPTED_POLICY_META = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"\s*\/?>/g;
const SCRIPTED_NO_REFERRER = /<meta name="referrer" content="no-referrer"\s*\/?>/;

/** Every href and src a page holds, double-quoted, as written. */
function urlsIn(html: string): string[] {
  return [...html.matchAll(/<[a-z]+\b[^>]*?[\s/"'](?:href|src)="([^"]*)"/gi)].map(
    (match) => match[1] ?? '',
  );
}

/** Whether a URL names a scheme or the root of the host, so leaves the page's own directory tree. */
function outsideUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || /^[/\\]/.test(value);
}

/**
 * Why a page with script (the board's index.html or the map demo's) may not
 * ship; empty when it may. Its policy comes first, once, ahead of all it
 * governs, with the hash of its one inline style and worker-src only where
 * `worker` says; a no-referrer meta comes before anything that loads; it
 * loads exactly SCRIPTED_SCRIPT and no inline script; and it holds no event
 * handler attribute, style attribute, frame, form, base, link or outside URL.
 */
export function scriptedPageProblems(html: string, page: { worker: boolean }): string[] {
  const problems: string[] = [];
  const metas = [...html.matchAll(SCRIPTED_POLICY_META)];
  const [meta] = metas;
  if (metas.length !== 1 || meta === undefined) {
    problems.push('lacks its policy, or holds it more than once');
  } else {
    for (const later of ['<title', '<style', '<script', '<link', '<body', '<img']) {
      const at = html.indexOf(later);
      if (at !== -1 && at < meta.index) problems.push(`has ${later} ahead of its policy`);
    }
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
    if (styles.length !== 1 || count(html, '<style') !== 1) {
      problems.push('holds other than one inline <style> block');
    } else {
      const hash = createHash('sha256')
        .update(styles[0]?.[1] ?? '', 'utf8')
        .digest('base64');
      if (meta[1] !== scriptedPolicy(hash, page.worker)) {
        problems.push(
          `its policy is not the site's for a page with script ${page.worker ? 'and a worker' : 'and no worker'}`,
        );
      }
    }
  }
  if (count(html, '<meta http-equiv') !== 1) problems.push('holds another http-equiv meta');
  const noReferrer = SCRIPTED_NO_REFERRER.exec(html);
  if (noReferrer === null) {
    problems.push('lacks the no-referrer meta');
  } else {
    for (const later of ['<script', '<link', '<body', '<img']) {
      const at = html.indexOf(later);
      if (at !== -1 && at < noReferrer.index) problems.push(`has ${later} ahead of no-referrer`);
    }
  }
  if (count(html.toLowerCase(), '<script') !== 1 || count(html, SCRIPTED_SCRIPT) !== 1) {
    problems.push('loads other than its one bundle, ./main.js, or holds an inline script');
  }
  if (ON_ATTRIBUTE.test(html)) problems.push('holds an on* event handler attribute');
  if (/<[a-z][^>]*?[\s/"']style\s*=/i.test(html)) problems.push('holds a style attribute');
  const forbidden =
    /<(iframe|frame|frameset|object|embed|applet|form|base|link|svg|math|template|portal)\b/i.exec(
      html,
    );
  if (forbidden) problems.push(`holds a <${forbidden[1]?.toLowerCase() ?? ''}> element`);
  for (const match of html.matchAll(
    /<[a-z][^>]*?[\s/"'](href|src|srcset|action|formaction)\s*=\s*(.)/gi,
  )) {
    if (match[2] !== '"') problems.push(`has an unquoted or single-quoted ${match[1] ?? ''}`);
  }
  for (const raw of urlsIn(html)) {
    if (outsideUrl(decodeReferences(raw).replace(/[\s\u0000-\u001f]/g, ''))) {
      problems.push(`names a URL outside the site, or from its root: ${raw}`);
    }
  }
  return problems;
}

/** Size limits on a page with script, in bytes. */
export interface ScriptedBudget {
  indexHtml: number;
  mainJs: number;
  mainJsGzip: number;
}

/**
 * ADR 0050's budget for the map demo: its index.html, and its main.js as
 * served and gzipped. The source map, which only developer tools fetch, is
 * outside it. Over budget means trimming the page, never raising this.
 */
export const MAP_DEMO_BUDGET: ScriptedBudget = {
  indexHtml: 16_000,
  mainJs: 800_000,
  mainJsGzip: 200_000,
};

/** What a page with script ships beside it: the page, its one bundle and that bundle's source map. */
export const SCRIPTED_FILES: readonly string[] = ['index.html', 'main.js', 'main.js.map'];

/** A test hook no published bundle may hold: the board's ?e2e handle and query, or the map fixture's connect hook. */
const TEST_HOOK = /__tabdock(?:Dock|MapPage)\b|\.(?:has|get)\(\s*["']e2e["']\s*\)/;

export interface ScriptedDir {
  /** Whether the page's policy names worker-src blob:, as only the board's does. */
  worker: boolean;
  /** Every directory beside the page: the root holds the tour, the guide and the map demo. */
  subdirs: readonly string[];
  /** Size limits, where an ADR sets them. */
  budget?: ScriptedBudget;
  /** Links the page must carry, as written, so a visitor finds what they lead to. */
  links?: readonly string[];
}

function bytes(value: number): string {
  return value.toLocaleString('en');
}

/**
 * Reads back a page with script and what sits beside it, at `at` under the
 * built site `siteDir` ('' for the root, 'map' for the map demo), and says
 * why any of it may not ship, each line naming its file relative to the
 * site: a file or directory other than those the page ships, a page failing
 * scriptedPageProblems, a bundle holding a test hook or over its budget, or
 * a link that leaves the site, leads to nothing the site holds, or that the
 * rules require and the page lacks. It runs once the whole site is written,
 * so a link to the tour or the guide is followed to its file.
 */
export async function scriptedDirProblems(
  siteDir: string,
  at: string,
  rules: ScriptedDir,
): Promise<string[]> {
  const problems: string[] = [];
  const dir = join(siteDir, at);
  const shown = (name: string): string => (at === '' ? name : `${at}/${name}`);
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      dirs.add(entry.name);
      if (!rules.subdirs.includes(entry.name)) {
        problems.push(`${shown(entry.name)}/: has no place beside a page with script`);
      }
    } else if (entry.isFile()) {
      files.add(entry.name);
      if (!SCRIPTED_FILES.includes(entry.name)) {
        problems.push(`${shown(entry.name)}: has no place beside a page with script`);
      }
    } else {
      problems.push(`${shown(entry.name)}: is neither a file nor a directory`);
    }
  }
  for (const name of SCRIPTED_FILES) {
    if (!files.has(name)) problems.push(`${shown(name)}: is missing`);
  }
  for (const name of rules.subdirs) {
    if (!dirs.has(name)) problems.push(`${shown(name)}/: is missing`);
  }

  if (files.has('index.html')) {
    const raw = await readFile(join(dir, 'index.html'));
    const html = raw.toString('utf8');
    for (const problem of scriptedPageProblems(html, { worker: rules.worker })) {
      problems.push(`${shown('index.html')}: ${problem}`);
    }
    if (rules.budget && raw.length > rules.budget.indexHtml) {
      problems.push(
        `${shown('index.html')}: ${bytes(raw.length)} bytes, over its budget of ${bytes(rules.budget.indexHtml)}`,
      );
    }
    const urls = urlsIn(html);
    for (const link of rules.links ?? []) {
      if (!urls.includes(link)) problems.push(`${shown('index.html')}: does not link ${link}`);
    }
    for (const url of urls) {
      const path = url.replace(/[?#].*$/, '');
      // Refused above already, or a link to a place on this same page.
      if (outsideUrl(path) || path === '') continue;
      const target = posix.normalize(posix.join(at === '' ? '.' : at, path));
      if (target === '..' || target.startsWith('../')) {
        problems.push(`${shown('index.html')}: links ${url}, outside the site`);
        continue;
      }
      const onDisk = join(siteDir, target);
      const file =
        path.endsWith('/') || (existsSync(onDisk) && statSync(onDisk).isDirectory())
          ? join(onDisk, 'index.html')
          : onDisk;
      if (!existsSync(file) || !statSync(file).isFile()) {
        problems.push(`${shown('index.html')}: links ${url}, which the site does not hold`);
      }
    }
  }

  if (files.has('main.js')) {
    const main = await readFile(join(dir, 'main.js'));
    if (TEST_HOOK.test(main.toString('utf8'))) {
      problems.push(`${shown('main.js')}: holds a test hook`);
    }
    if (rules.budget) {
      const gzipped = gzipSync(main).length;
      if (main.length > rules.budget.mainJs) {
        problems.push(
          `${shown('main.js')}: ${bytes(main.length)} bytes, over its budget of ${bytes(rules.budget.mainJs)}`,
        );
      }
      if (gzipped > rules.budget.mainJsGzip) {
        problems.push(
          `${shown('main.js')}: ${bytes(gzipped)} bytes gzipped, over its budget of ${bytes(rules.budget.mainJsGzip)}`,
        );
      }
    }
  }
  return problems.sort();
}

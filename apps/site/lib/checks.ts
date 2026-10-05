// What the build refuses to ship (ADR 0029). Tour pages share an origin with
// the demo board, which the relay's allowlist vouches for and whose tab keeps
// the adapter's records in sessionStorage, so a tour page must hold no script
// of any kind and run under its policy, and every diagram must be a plain
// picture that names nothing outside the site. These checks read the files as
// written to dist, so what they pass is what Pages serves.

import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

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

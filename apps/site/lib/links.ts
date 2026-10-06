// Links in the site's Markdown pages, rewritten for the site (ADRs 0029 and
// 0035). The site publishes collections of pages, the tour and the guide,
// each from its own docs/ directory into its own directory on the site. A
// link to a page of either collection becomes that page's .html page, beside
// the page or in the other collection's directory, and a link to a page that
// does not exist stops the build rather than ship a dead link; a link into a
// collection's img/ stays on the site, since the build copies those files;
// any other repository path becomes a GitHub link at the commit built, so a
// reader on a phone lands on the code the page describes. Anything else that
// is not http, https or mailto fails the build rather than reach a page that
// shares the demo's origin.

import { posix } from 'node:path';

/** The repository the site is built from, as GitHub shows it. */
export interface Repository {
  /** Its web address, such as https://github.com/<owner>/<name>, with no trailing slash. */
  web: string;
  /** The full commit built. */
  commit: string;
}

/** One set of Markdown pages the site publishes. */
export interface Collection {
  /** Where its sources live in the repository, such as docs/tour. */
  dir: string;
  /** Its directory on the site, such as tour. */
  out: string;
  /** The stem of the source that is its index page, such as README, if it has one. */
  indexStem?: string | undefined;
  /** Its pages by stem, such as 00-baseline, the index aside. */
  pages: ReadonlySet<string>;
}

export interface LinkContext {
  repository: Repository;
  /** The collection the page being rendered belongs to. */
  collection: Collection;
  /** Every collection the site builds, the page's own among them. */
  collections: readonly Collection[];
}

/** Where the tour's sources live in the repository. */
export const TOUR_DIR = 'docs/tour';
/** Where the guide's sources live (ADR 0035). */
export const GUIDE_DIR = 'docs/guide';

/** A link or image the site will not carry; the build stops on it. */
export class LinkError extends Error {}

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto']);

/** The repository path a relative or root-relative href names, with its query or fragment apart. */
function repositoryPath(
  href: string,
  base: string,
): { path: string; suffix: string; directory: boolean } {
  const cut = href.search(/[?#]/);
  const raw = cut === -1 ? href : href.slice(0, cut);
  const suffix = cut === -1 ? '' : href.slice(cut);
  const joined = raw.startsWith('/') ? raw.slice(1) : posix.join(base, raw);
  const normal = posix.normalize(joined === '' ? '.' : joined);
  if (normal === '..' || normal.startsWith('../')) {
    throw new LinkError(`${href} leaves the repository`);
  }
  const directory = raw === '' || raw.endsWith('/') || normal === '.' || normal === './';
  const path = normal.replace(/\/$/, '').replace(/^\.$/, '');
  return { path, suffix, directory };
}

/** Where a collection's files are reached from a page of `from`: beside it, or in its own directory. */
function prefixFor(collection: Collection, from: Collection): string {
  return collection.dir === from.dir ? '' : `../${collection.out}/`;
}

export function rewriteLink(href: string, context: LinkContext): string {
  const trimmed = href.trim();
  if (trimmed === '') throw new LinkError('a link with no address');
  if (trimmed.startsWith('#')) return trimmed;
  const scheme = SCHEME.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    if (ALLOWED_SCHEMES.has(scheme)) return trimmed;
    throw new LinkError(`${scheme}: links are refused (${trimmed})`);
  }
  if (trimmed.startsWith('//') || trimmed.startsWith('\\')) {
    throw new LinkError(`${trimmed} names another host without a scheme`);
  }
  const { path, suffix, directory } = repositoryPath(trimmed, context.collection.dir);
  for (const collection of context.collections) {
    const prefix = prefixFor(collection, context.collection);
    if (path === collection.dir) return `${prefix}index.html${suffix}`;
    if (posix.dirname(path) === collection.dir && path.endsWith('.md')) {
      const stem = posix.basename(path, '.md');
      if (stem === collection.indexStem) return `${prefix}index.html${suffix}`;
      if (collection.pages.has(stem)) return `${prefix}${stem}.html${suffix}`;
      throw new LinkError(`${path} is no page of ${collection.dir}`);
    }
    if (path.startsWith(`${collection.dir}/img/`)) {
      return `${prefix}${path.slice(collection.dir.length + 1)}${suffix}`;
    }
  }
  const { web, commit } = context.repository;
  if (path === '') return `${web}/tree/${commit}${suffix}`;
  return `${web}/${directory ? 'tree' : 'blob'}/${commit}/${path}${suffix}`;
}

/**
 * An image must be one of its collection's own, copied beside the pages:
 * site pages allow images from the site alone (img-src 'self').
 */
export function rewriteImage(href: string, collection: Collection): string {
  const trimmed = href.trim();
  const images = `${collection.dir}/img/`;
  if (SCHEME.test(trimmed) || trimmed.startsWith('//') || trimmed.startsWith('\\')) {
    throw new LinkError(`the image ${trimmed} is not one of ${collection.dir}'s own`);
  }
  if (/[?#]/.test(trimmed)) throw new LinkError(`the image ${trimmed} carries a query or fragment`);
  const { path } = repositoryPath(trimmed, collection.dir);
  if (!path.startsWith(images)) {
    throw new LinkError(`the image ${trimmed} is outside ${images}`);
  }
  return path.slice(collection.dir.length + 1);
}

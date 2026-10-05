// Which repository and commit the site is built from, for the GitHub links
// of links.ts. In Actions the runner names both; in a clone, git does. The
// address is read at build time and never written into a file in the
// repository, so the owner's account stays out of committed text.

import { execFileSync } from 'node:child_process';
import type { Repository } from './links.ts';

const COMMIT = /^[0-9a-f]{40}$/;
const SLUG = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const SERVER = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/;

/** owner/name from a GitHub remote, over https or ssh, or null for anything else. */
export function slugFromRemote(remote: string): string | null {
  const match =
    /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim()) ??
    /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/.exec(remote.trim());
  const slug = match?.[1];
  return slug !== undefined && SLUG.test(slug) ? slug : null;
}

export function repositoryFrom(
  env: Readonly<Record<string, string | undefined>>,
  git: (args: string[]) => string,
): Repository {
  const ask = (args: string[]): string => {
    try {
      return git(args).trim();
    } catch {
      return '';
    }
  };
  const server = env.GITHUB_SERVER_URL?.trim() || 'https://github.com';
  const slug =
    env.GITHUB_REPOSITORY?.trim() || slugFromRemote(ask(['remote', 'get-url', 'origin']));
  const commit = env.GITHUB_SHA?.trim() || ask(['rev-parse', 'HEAD']);
  if (!SERVER.test(server)) throw new Error(`GITHUB_SERVER_URL is not an https origin: ${server}`);
  if (slug === null || !SLUG.test(slug)) {
    throw new Error(
      'cannot tell which GitHub repository this is: set GITHUB_REPOSITORY to <owner>/<name>',
    );
  }
  if (!COMMIT.test(commit)) throw new Error(`the commit to link to is not a full SHA: ${commit}`);
  return { web: `${server}/${slug}`, commit };
}

export function resolveRepository(repoRoot: string): Repository {
  return repositoryFrom(process.env, (args) =>
    execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  );
}

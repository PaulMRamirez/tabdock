// publish.yml as ADR 0028 has it, read as text with comments left out: a
// published release is its only trigger; the pack job first checks that the
// tag names a commit on main (ADR 0028's A5.6 notes), which this file also
// runs against a scratch repository, then builds and checks the tarballs
// against the tag with read access only; the stage job alone holds an OIDC
// token, waits for the `npm` environment's approval, runs no repository code
// and only stages, with provenance, protocol first and relay last; and only
// the attach job may write to the repository, to add the release's files.
// The general workflow rules (pinned actions, no default permission, no
// expression spliced into a script, a secret only behind an environment) are
// deploy-files.test.ts's.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT } from '../src/local-harness.ts';

const text = readFileSync(join(ROOT, '.github/workflows/publish.yml'), 'utf8')
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .map((line) => line.replace(/\s+#\s.*$/, ''))
  .join('\n');

/** Each job's text, by name. */
const jobs = new Map(
  (text.split(/^jobs:\n/m)[1] ?? '')
    .split(/\n(?= {2}[a-z][\w-]*:\n)/)
    .map((job) => [/^ {2}([a-z][\w-]*):/.exec(job)?.[1] ?? '', job] as const),
);

function job(name: string): string {
  const found = jobs.get(name);
  if (found === undefined) throw new Error(`publish.yml has no ${name} job`);
  return found;
}

const MAIN_CHECK = 'Check that the tag is on main';

/** The main check's run script, as the runner hands it to bash. */
function mainCheckScript(): string {
  const lines = job('pack').split('\n');
  const start = lines.findIndex((line) => line === `      - name: ${MAIN_CHECK}`);
  const run = lines.findIndex((line, index) => index > start && line === '        run: |');
  const script: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== '' && !line.startsWith(' '.repeat(10))) break;
    script.push(line.slice(10));
  }
  return `${script.join('\n').trimEnd()}\n`;
}

describe('publish.yml (ADR 0028)', () => {
  it('runs only when a release is published, with no permission by default', () => {
    expect(text).toMatch(/^on:\n {2}release:\n {4}types: \[published\]\n\n/m);
    expect(text).not.toMatch(
      /^ {2}(push|pull_request|pull_request_target|workflow_dispatch|workflow_run|schedule):/m,
    );
    expect(text).toMatch(/^permissions: \{\}$/m);
    expect([...jobs.keys()]).toEqual(['pack', 'stage', 'attach']);
  });

  it('checks that the tag names a commit on main before any repository code runs', () => {
    const pack = job('pack');
    expect(pack).toMatch(/persist-credentials: false\n {10}fetch-depth: 0\n/);
    const check = pack.indexOf(`- name: ${MAIN_CHECK}\n`);
    expect(check).toBeGreaterThan(pack.indexOf('actions/checkout@'));
    expect(check).toBeLessThan(pack.indexOf('corepack enable'));
    expect(check).toBeLessThan(pack.indexOf('pnpm install'));
    const step = pack.slice(check, pack.indexOf('\n      - ', check + 1));
    expect(step).toContain('TAG: ${{ github.event.release.tag_name }}');
    expect(step).not.toMatch(/^ {8}(if|continue-on-error):/m);
    const script = mainCheckScript();
    expect(script).toContain('git merge-base --is-ancestor "$GITHUB_SHA" refs/remotes/origin/main');
    expect(script).toContain('>> "$GITHUB_STEP_SUMMARY"');
  });

  it('packs and checks the tarballs against the tag, reading the repository only', () => {
    const pack = job('pack');
    expect(pack).toMatch(/permissions:\n {6}contents: read\n/);
    expect(pack).not.toMatch(/id-token|contents: write|environment:/);
    expect(pack).toContain('pnpm install --frozen-lockfile');
    expect(pack).toContain('pnpm release:pack dist/packages');
    expect(pack).toContain('TAG: ${{ github.event.release.tag_name }}');
    expect(pack).toContain('pnpm release:check dist/packages --tag "$TAG"');
    expect(pack).toContain('pnpm pack:install dist/packages');
    expect(pack).toMatch(/persist-credentials: false/);
  });

  it('stages behind the npm environment, with the only OIDC token, running no repository code', () => {
    const stage = job('stage');
    expect(stage).toMatch(/needs: pack\n/);
    expect(stage).toMatch(/if: startsWith\(github\.event\.release\.tag_name, 'v'\)\n/);
    expect(stage).toMatch(/environment: npm\n/);
    expect(stage).toMatch(/permissions:\n {6}contents: read\n {6}id-token: write\n/);
    expect(text.match(/id-token: write/g)).toHaveLength(1);
    expect(stage).not.toMatch(/actions\/checkout|pnpm|corepack/);
    expect(stage).toContain('sha256sum --check --strict SHA256SUMS');
    expect(stage).toMatch(/node-version: 24\.21\.0\n/);
    expect(stage).toContain('test "$(npm --version)" = 11.19.0');
    expect(stage).toContain('for name in protocol adapter relay; do');
    expect(stage).toContain(
      'npm stage publish ./tabdock-"$name"-*.tgz --provenance --access public',
    );
    // Staging only: nothing here can make a version live.
    expect(text).not.toMatch(/npm publish\b/);
  });

  it('lets only the attach job write, to add the release’s files', () => {
    const attach = job('attach');
    expect(attach).toMatch(/needs: stage\n/);
    expect(attach).toMatch(/permissions:\n {6}contents: write\n/);
    expect(attach).not.toMatch(/id-token|environment:|secrets\./);
    expect(attach).toContain(
      'gh release upload "$TAG" packages/*.tgz packages/SHA256SUMS packages/tabdock-adapter.integrity.txt',
    );
    expect(text.match(/contents: write/g)).toHaveLength(1);
  });
});

describe("publish.yml's main check, run as the runner runs it", () => {
  let repo = '';
  let script = '';
  let older = '';
  let merged = '';
  let unreviewed = '';
  const git = (...args: string[]): string => {
    const ran = spawnSync(
      'git',
      [
        '-c',
        'user.name=Tabdock test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'tag.gpgsign=false',
        ...args,
      ],
      { cwd: repo, encoding: 'utf8' },
    );
    expect(ran.status, ran.stderr).toBe(0);
    return ran.stdout.trim();
  };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'tabdock-publish-main-'));
    // main has two commits, which actions/checkout's full fetch names
    // refs/remotes/origin/main; a side branch has a third that never merged.
    git('init', '--quiet', '--initial-branch=main');
    git('commit', '--quiet', '--allow-empty', '--message', 'first');
    older = git('rev-parse', 'HEAD');
    git('commit', '--quiet', '--allow-empty', '--message', 'merge');
    merged = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', merged);
    git('checkout', '--quiet', '-b', 'side');
    git('commit', '--quiet', '--allow-empty', '--message', 'unreviewed');
    unreviewed = git('rev-parse', 'HEAD');
    git('tag', 'v0.1.0', merged);
    git('tag', '--annotate', '--message', 'annotated', 'v0.1.1', merged);
    git('tag', 'v0.0.9', older);
    git('tag', 'v0.1.2', unreviewed);
    script = join(repo, '.main-check.sh');
    writeFileSync(script, mainCheckScript());
  });
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function run(tag: string, sha: string): { status: number | null; summary: string } {
    const summary = join(repo, `.summary-${tag}-${sha}`);
    writeFileSync(summary, '');
    const ran = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, TAG: tag, GITHUB_SHA: sha, GITHUB_STEP_SUMMARY: summary },
    });
    return { status: ran.status, summary: readFileSync(summary, 'utf8') };
  }

  it('passes a tag, light or annotated, on a commit in main, and writes it to the summary', () => {
    for (const [tag, sha] of [
      ['v0.1.0', merged],
      ['v0.1.1', merged],
      ['v0.0.9', older],
    ] as const) {
      const { status, summary } = run(tag, sha);
      expect(status, tag).toBe(0);
      expect(summary).toContain(`### Release ${tag}`);
      expect(summary).toContain(`- This run's commit: ${sha}`);
      expect(summary).toContain(`- The tag's commit: ${sha}`);
      expect(summary).toContain('- On main: yes');
    }
  });

  it('refuses a tag on a commit main does not hold', () => {
    const { status, summary } = run('v0.1.2', unreviewed);
    expect(status).not.toBe(0);
    expect(summary).toContain('- On main: no');
  });

  it("refuses a run whose commit is not the tag's, and a tag that does not exist", () => {
    expect(run('v0.1.0', unreviewed).status).not.toBe(0);
    const missing = run('v9.9.9', merged);
    expect(missing.status).not.toBe(0);
    expect(missing.summary).toContain("- The tag's commit: none");
    expect(missing.summary).toContain('- On main: no');
  });
});

// publish.yml as ADR 0028 has it, read as text with comments left out: a
// published release is its only trigger; the pack job builds and checks the
// tarballs against the tag with read access only; the stage job alone holds
// an OIDC token, waits for the `npm` environment's approval, runs no
// repository code and only stages, with provenance, protocol first and relay
// last; and only the attach job may write to the repository, to add the
// release's files. The general workflow rules (pinned actions, no default
// permission, no expression spliced into a script, a secret only behind an
// environment) are deploy-files.test.ts's.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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

describe('publish.yml (ADR 0028)', () => {
  it('runs only when a release is published, with no permission by default', () => {
    expect(text).toMatch(/^on:\n {2}release:\n {4}types: \[published\]\n\n/m);
    expect(text).not.toMatch(
      /^ {2}(push|pull_request|pull_request_target|workflow_dispatch|workflow_run|schedule):/m,
    );
    expect(text).toMatch(/^permissions: \{\}$/m);
    expect([...jobs.keys()]).toEqual(['pack', 'stage', 'attach']);
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

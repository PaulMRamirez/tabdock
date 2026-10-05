import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { repositoryFrom, slugFromRemote } from './repo.ts';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

describe('which repository the site links to', () => {
  it('reads owner/name from a GitHub remote over https or ssh, and nothing else', () => {
    assert.equal(slugFromRemote('https://github.com/owner/tabdock'), 'owner/tabdock');
    assert.equal(slugFromRemote('https://github.com/owner/tabdock.git'), 'owner/tabdock');
    assert.equal(slugFromRemote('git@github.com:owner/tabdock.git'), 'owner/tabdock');
    assert.equal(slugFromRemote('http://127.0.0.1:9/git/owner/tabdock'), null);
    assert.equal(slugFromRemote('https://github.com/owner/tab dock'), null);
  });

  it("prefers the Actions runner's names, then git", () => {
    const git = (args: string[]) =>
      args[0] === 'rev-parse' ? `${'f'.repeat(40)}\n` : 'https://github.com/someone/fork.git\n';
    assert.deepEqual(
      repositoryFrom({ GITHUB_REPOSITORY: 'owner/tabdock', GITHUB_SHA: COMMIT }, git),
      { web: 'https://github.com/owner/tabdock', commit: COMMIT },
    );
    assert.deepEqual(repositoryFrom({}, git), {
      web: 'https://github.com/someone/fork',
      commit: 'f'.repeat(40),
    });
  });

  it('stops rather than link to a guess', () => {
    const noGit = () => {
      throw new Error('not a repository');
    };
    assert.throws(() => repositoryFrom({}, noGit), /set GITHUB_REPOSITORY/);
    assert.throws(
      () => repositoryFrom({ GITHUB_REPOSITORY: 'owner/tabdock', GITHUB_SHA: 'main' }, noGit),
      /not a full SHA/,
    );
    assert.throws(
      () =>
        repositoryFrom(
          {
            GITHUB_REPOSITORY: 'owner/tabdock',
            GITHUB_SHA: COMMIT,
            GITHUB_SERVER_URL: 'javascript:x',
          },
          noGit,
        ),
      /not an https origin/,
    );
  });
});

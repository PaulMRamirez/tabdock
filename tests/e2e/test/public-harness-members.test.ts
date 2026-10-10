// The public harness's members file (ADR 0043), which demo:m6 and the
// browser specs build on: the members go to a 0600 file in a private
// directory, the relay reads them from there, and saveMembers changes them
// for the relay to read again, with no restart.

import { existsSync, statSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { type PublicTabdock, startPublicTabdock } from '../src/public-harness.ts';

let tabdock: PublicTabdock | undefined;

afterEach(async () => {
  await tabdock?.close();
  tabdock = undefined;
});

describe('startPublicTabdock with a members file', () => {
  it('lists the members in a private file the relay reads again when it changes', async () => {
    const bob = { sub: 'sub-bob', userId: 'bob', displayName: 'Bob' };
    tabdock = await startPublicTabdock({ membersFile: true, users: [bob] });
    const file = tabdock.membersFile;
    if (file === null) throw new Error('no members file');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await tabdock.relay.reloadMembers()).toBe('unchanged');
    tabdock.saveMembers([{ sub: 'sub-alice-only', userId: 'alice', displayName: 'Alice' }]);
    expect(await tabdock.relay.reloadMembers()).toBe('applied');
    expect(tabdock.relay.audit.events()).toContainEqual(
      expect.objectContaining({ type: 'members_reloaded', members: 1, removed: ['bob'] }),
    );
    await tabdock.close();
    tabdock = undefined;
    expect(existsSync(file)).toBe(false);
  });

  it('keeps TABDOCK_OAUTH_USERS without the option', async () => {
    tabdock = await startPublicTabdock();
    expect(tabdock.membersFile).toBeNull();
    expect(await tabdock.relay.reloadMembers()).toBe('unchanged');
    expect(() => {
      tabdock?.saveMembers([]);
    }).toThrow('this Tabdock has no members file');
  });
});

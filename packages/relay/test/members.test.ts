// The member list and the members file's rules, without a relay (ADR 0043):
// the file's lines, the diff a reload hands the hub, and the poll that reads
// a file only once its stat has held still for a whole poll, so a write still
// under way is never applied, and applies each text once. The poll's stat is
// stood in for, so a test decides when the file "changed"; the text is real.

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INVITEE_ID_PREFIX, MAX_MEMBERS, MAX_MEMBERS_FILE_BYTES } from '@tabdock/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  inviteeKeyOf,
  joinChanges,
  type MemberChange,
  type MemberFileStat,
  MemberList,
  MembersError,
  membersDigest,
  parseMembersFile,
  readMembersFile,
  settlingMembers,
  watchMembersFile,
} from '../src/members.ts';
import { parseOAuthUsers } from '../src/oauth.ts';
import { leakIn } from './helpers/secrecy.ts';

const TOKEN_LIKE = 'tabdock_Zq7MarkSecretRun0123456789abcdefghijk';

const scratches: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tabdock-members-')));
  scratches.push(dir);
  return dir;
}

function refusal(run: () => unknown): MembersError {
  try {
    run();
  } catch (error) {
    if (error instanceof MembersError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

function inviteeId(sub: string): string {
  return `${INVITEE_ID_PREFIX}${inviteeKeyOf(sub)}`;
}

describe('a members file (ADR 0043)', () => {
  it('takes one entry a line, with comments, blank lines, CRLF, a byte order mark and commas in names', () => {
    const text =
      "﻿# The owner's members\r\n\r\nuser_01=alice:Alice Smith, PhD\r\n   # indented comment\n" +
      'google-oauth2|42=bob\n  auth0|x=carol:Carol: the = sign  \n';
    expect(parseMembersFile(text)).toEqual([
      { sub: 'user_01', userId: 'alice', displayName: 'Alice Smith, PhD' },
      { sub: 'google-oauth2|42', userId: 'bob', displayName: 'bob' },
      { sub: 'auth0|x', userId: 'carol', displayName: 'Carol: the = sign' },
    ]);
  });

  it('names a bad line by its number and a fixed phrase, never its text', () => {
    const cases: [string, string, number | null][] = [
      [
        `a=alice\n${TOKEN_LIKE}\n`,
        'TABDOCK_MEMBERS_FILE line 2 is not of the form sub=userId:Display Name',
        2,
      ],
      [
        `# x\na=alice\nb=${TOKEN_LIKE}.x\n`,
        "TABDOCK_MEMBERS_FILE line 3 has a user id that is not 1 to 64 letters, digits, '_' or '-'",
        3,
      ],
      [
        `a=alice\nb=g_${TOKEN_LIKE.slice(0, 20)}\n`,
        "TABDOCK_MEMBERS_FILE line 2 has a user id starting g_, which only an invitee's may (ADR 0017)",
        2,
      ],
      [
        `a${TOKEN_LIKE} b=alice\n`,
        'TABDOCK_MEMBERS_FILE line 1 has a sub that is not 1 to 255 printable characters',
        1,
      ],
      [
        `a=alice:${'x'.repeat(101)}\n`,
        'TABDOCK_MEMBERS_FILE line 1 has a display name that is not 1 to 100 characters',
        1,
      ],
      [
        `${TOKEN_LIKE}=alice\n\nb=bob\n${TOKEN_LIKE}=carol\n`,
        'TABDOCK_MEMBERS_FILE lines 1 and 4 share a sub',
        4,
      ],
      [
        `a=${'z'.repeat(9)}\nb=${'z'.repeat(9)}\n`,
        'TABDOCK_MEMBERS_FILE lines 1 and 2 name the same user id',
        2,
      ],
      ['# nobody yet\n\n', 'TABDOCK_MEMBERS_FILE lists no members (ADR 0043)', null],
    ];
    for (const [text, words, line] of cases) {
      const error = refusal(() => parseMembersFile(text));
      expect(error.message, text).toBe(words);
      expect(error.line, text).toBe(line);
      expect(leakIn(error.message, TOKEN_LIKE), text).toBeNull();
    }
  });

  it(`holds at most ${String(MAX_MEMBERS)} entries`, () => {
    const lines = (count: number): string =>
      Array.from({ length: count }, (_, index) => `s${String(index)}=u${String(index)}`).join('\n');
    expect(parseMembersFile(lines(MAX_MEMBERS))).toHaveLength(MAX_MEMBERS);
    const error = refusal(() => parseMembersFile(`# head\n${lines(MAX_MEMBERS + 1)}`));
    expect(error.problem).toBe('too_many');
    expect(error.message).toBe('TABDOCK_MEMBERS_FILE lists more than 500 members (ADR 0043)');
    expect(error.line).toBe(MAX_MEMBERS + 2);
  });

  it('reads the same entries TABDOCK_OAUTH_USERS does, one rule for both', () => {
    expect(parseOAuthUsers('a=alice:Alice,b=bob')).toEqual(
      parseMembersFile('a=alice:Alice\nb=bob'),
    );
    expect(() => parseOAuthUsers(`a=alice:${'x'.repeat(101)}`)).toThrow(
      'TABDOCK_OAUTH_USERS entry 1 has a display name that is not 1 to 100 characters',
    );
  });

  it('is refused when larger than the cap or not UTF-8, without reading what it says', () => {
    const dir = scratch();
    const large = join(dir, 'large.txt');
    writeFileSync(large, `a=alice\n#${'x'.repeat(MAX_MEMBERS_FILE_BYTES)}\n`, { mode: 0o600 });
    expect(refusal(() => readMembersFile(large)).message).toBe(
      'TABDOCK_MEMBERS_FILE is larger than 262144 bytes (ADR 0043)',
    );
    const binary = join(dir, 'binary.txt');
    writeFileSync(binary, Buffer.from([0x61, 0x3d, 0xff, 0xfe, 0x0a]), { mode: 0o600 });
    expect(refusal(() => readMembersFile(binary)).problem).toBe('not_utf8');
  });
});

describe('MemberList.replace (ADR 0043, S8, S13)', () => {
  const ALICE = { sub: 's-alice', userId: 'alice', displayName: 'Alice' };
  const BOB = { sub: 's-bob', userId: 'bob', displayName: 'Bob' };

  it('maps subjects live and says whose user id the change moved', () => {
    const list = new MemberList([ALICE, BOB]);
    expect(list.bySub('s-bob')).toEqual({ userId: 'bob', displayName: 'Bob' });
    const change = list.replace(
      [
        { ...ALICE, displayName: 'Alice Smith' },
        { sub: 's-carol', userId: 'carol', displayName: 'Carol' },
      ],
      'd1',
    );
    expect(list.bySub('s-bob')).toBeUndefined();
    expect(list.digest).toBe('d1');
    // Bob loses bob; Carol loses the invitee id she held; carol is new, so
    // anything a former holder left under it ends too.
    expect(change.ended).toEqual(new Set(['bob', inviteeId('s-carol'), 'carol']));
    expect(change.renamed).toEqual(new Map([['alice', 'Alice Smith']]));
    expect(change.added).toEqual(['carol']);
    expect(change.removed).toEqual(['bob']);
    expect(change.total).toBe(2);
    expect(change.memberNames).toEqual(['Alice Smith', 'Carol']);
  });

  it('ends an id handed to another subject, and the subject that lost it', () => {
    const list = new MemberList([ALICE, BOB]);
    const change = list.replace(
      [{ sub: 's-other', userId: 'alice', displayName: 'Alice' }, BOB],
      null,
    );
    expect(change.ended).toEqual(new Set(['alice', inviteeId('s-other')]));
    expect(change.added).toEqual([]);
    expect(change.removed).toEqual([]);
    expect(change.renamed.size).toBe(0);
  });

  it('changes nothing for the same list', () => {
    const list = new MemberList([ALICE, BOB]);
    const change = list.replace([BOB, ALICE], 'd2');
    expect(change.ended.size).toBe(0);
    expect(change.renamed.size).toBe(0);
  });
});

describe('settlingMembers (ADR 0043, S8)', () => {
  const ALICE = { sub: 's-alice', userId: 'alice', displayName: 'Alice' };
  const BOB = { sub: 's-bob', userId: 'bob', displayName: 'Bob' };
  const CAROL = { sub: 's-carol', userId: 'carol', displayName: 'Carol' };

  it('settles a change whose settling failed again with the next, so no ended id is forgotten', () => {
    const list = new MemberList([ALICE, BOB]);
    const settled: MemberChange[] = [];
    let fail = true;
    const apply = settlingMembers(list, (change) => {
      settled.push(change);
      if (fail) {
        fail = false;
        throw new Error('a step failed');
      }
    });
    expect(() => {
      apply([ALICE], 'd1');
    }).toThrow('a step failed');
    // The list is in force already, so the next request maps as it says.
    expect(list.bySub('s-bob')).toBeUndefined();
    // The same text applied again: compared with itself it changes nothing,
    // yet Bob's id is settled once more.
    apply([ALICE], 'd1');
    expect(settled).toHaveLength(2);
    expect(settled[1]?.ended).toEqual(new Set(['bob']));
    expect(settled[1]?.removed).toEqual(['bob']);
    // Settled, it is owed no longer.
    apply([ALICE], 'd1');
    expect(settled[2]?.ended.size).toBe(0);
  });

  it('joins two changes as the second made on top of the first', () => {
    const list = new MemberList([ALICE, BOB]);
    const first = list.replace([{ ...ALICE, displayName: 'Ally' }, CAROL], null);
    const second = list.replace([{ ...ALICE, displayName: 'Ally' }, BOB], null);
    const joined = joinChanges(first, second);
    expect(joined.ended).toEqual(
      new Set(['bob', inviteeId('s-bob'), 'carol', inviteeId('s-carol')]),
    );
    expect(joined.renamed).toEqual(new Map([['alice', 'Ally']]));
    // Bob left and came back, Carol came and left: neither is added or removed in all.
    expect(joined.added).toEqual([]);
    expect(joined.removed).toEqual([]);
    expect(joined.total).toBe(2);
    expect(joined.memberNames).toEqual(['Ally', 'Bob']);
  });
});

/** A stat the test chooses, so it decides when the file "changed" between polls. */
function fakeStat(generation: number): MemberFileStat {
  return {
    dev: 1,
    ino: 7,
    size: 100,
    mtimeMs: generation,
    ctimeMs: generation,
    mode: 0o100600,
    uid: 0,
  };
}

function fakeLog(): {
  warns: Record<string, unknown>[];
  log: Parameters<typeof watchMembersFile>[0]['log'];
} {
  const warns: Record<string, unknown>[] = [];
  return {
    warns,
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: (message, fields) => {
        warns.push({ message, ...fields });
      },
      error: (message, fields) => {
        warns.push({ message, ...fields });
      },
    },
  };
}

describe('watchMembersFile (ADR 0043)', () => {
  const V1 = 's-alice=alice:Alice\n';
  const V2 = 's-alice=alice:Alice\ns-bob=bob:Bob\n';
  // What a reader would see halfway through writing V2: still a valid list.
  const HALF = 's-alice=alice:Alice\ns-bob=bo';

  it('reads a file only once its stat held still for a whole poll, and applies each text once', () => {
    vi.useFakeTimers();
    const file = join(scratch(), 'members.txt');
    writeFileSync(file, V1, { mode: 0o600 });
    let stat = fakeStat(1);
    const applied: string[] = [];
    const { log } = fakeLog();
    const watch = watchMembersFile({
      path: file,
      system: { stat: () => stat },
      intervalMs: 100,
      applied: membersDigest(V1),
      apply: (entries) => applied.push(entries.map((entry) => entry.userId).join(',')),
      log,
    });
    vi.advanceTimersByTime(300);
    expect(applied).toEqual([]);
    // A write lands, and the poll sees a new stat: it waits.
    writeFileSync(file, HALF);
    stat = fakeStat(2);
    vi.advanceTimersByTime(100);
    // The write goes on before the next poll: still not read.
    writeFileSync(file, V2);
    stat = fakeStat(3);
    vi.advanceTimersByTime(100);
    expect(applied).toEqual([]);
    // Held still for a whole poll: read once and applied.
    vi.advanceTimersByTime(100);
    expect(applied).toEqual(['alice,bob']);
    vi.advanceTimersByTime(1000);
    expect(applied).toEqual(['alice,bob']);
    // The same text saved again: a new stat, the same digest, nothing applied.
    writeFileSync(file, V2);
    stat = fakeStat(4);
    vi.advanceTimersByTime(1000);
    expect(applied).toEqual(['alice,bob']);
    watch.stop();
  });

  it('keeps the list on a malformed or missing file, logging each problem once by line, and recovers', () => {
    vi.useFakeTimers();
    const file = join(scratch(), 'members.txt');
    writeFileSync(file, V1, { mode: 0o600 });
    let generation = 1;
    let missing = false;
    const applied: string[] = [];
    const { warns, log } = fakeLog();
    const watch = watchMembersFile({
      path: file,
      system: {
        stat: () => {
          if (missing) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
          return fakeStat(generation);
        },
      },
      intervalMs: 100,
      applied: membersDigest(V1),
      apply: (entries) => applied.push(entries.map((entry) => entry.userId).join(',')),
      log,
    });
    writeFileSync(file, `s-alice=alice\n${TOKEN_LIKE}\n`);
    generation = 2;
    vi.advanceTimersByTime(1000);
    expect(applied).toEqual([]);
    expect(warns).toEqual([
      {
        message: 'members file refused; keeping the list read last',
        problem: 'malformed',
        line: 2,
      },
    ]);
    missing = true;
    vi.advanceTimersByTime(1000);
    expect(warns.at(-1)).toEqual({
      message: 'members file refused; keeping the list read last',
      problem: 'missing',
      line: null,
    });
    expect(warns).toHaveLength(2);
    missing = false;
    writeFileSync(file, V2);
    generation = 3;
    vi.advanceTimersByTime(1000);
    expect(applied).toEqual(['alice,bob']);
    expect(warns).toHaveLength(2);
    expect(leakIn(JSON.stringify(warns), TOKEN_LIKE)).toBeNull();
    expect(JSON.stringify(warns)).not.toContain(file);
    watch.stop();
  });

  it('reads at once on reloadNow, without waiting for the poll', () => {
    const file = join(scratch(), 'members.txt');
    writeFileSync(file, V1, { mode: 0o600 });
    const applied: string[] = [];
    const watch = watchMembersFile({
      path: file,
      intervalMs: 60_000,
      applied: membersDigest(V1),
      apply: (entries) => applied.push(entries.map((entry) => entry.userId).join(',')),
      log: fakeLog().log,
    });
    expect(watch.reloadNow()).toBe('unchanged');
    writeFileSync(file, V2);
    expect(watch.reloadNow()).toBe('applied');
    expect(watch.reloadNow()).toBe('unchanged');
    writeFileSync(file, '');
    expect(watch.reloadNow()).toBe('refused');
    expect(applied).toEqual(['alice,bob']);
    watch.stop();
  });
});

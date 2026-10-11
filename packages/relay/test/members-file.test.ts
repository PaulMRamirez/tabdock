// A6.14: the members file (ADR 0043). Public URL mode against the stand-in
// provider, its members read from a file in a private directory: the file
// is read at start, and again on a change without a restart; an added
// member pairs while everyone else keeps what they had; a removed member,
// or an account whose user id moves, loses every attachment (in-flight
// calls cancelled, page state waits answered), pending request, invite it
// sponsored, /pair sign-in, 2025-era session and listen stream held under
// the old id at once (S8), and an id handed to someone else shows them none
// of its former holder's pages (S13). A file that is malformed, empty,
// missing or that another account could change keeps the list in force,
// and every refusal names a line by number, never its text or the file's
// path (S11).

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Client, FetchLike } from '@modelcontextprotocol/client';
import { type AuthInfo, createMcpHandler } from '@modelcontextprotocol/server';
import {
  INVITEE_ID_PREFIX,
  INVITEE_SHORT_ID_CHARS,
  MAX_MEMBERS,
  MEMBERS_POLL_MS,
} from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { startRelay as startFromEnv } from '../src/cli.ts';
import { resolveConfig } from '../src/config.ts';
import type { PageHub } from '../src/hub.ts';
import {
  createDevTokenAuth,
  createMemoryStore,
  type DevTokenUser,
  inviteeKeyOf,
  loadConfigFromEnv,
} from '../src/index.ts';
import { createMcpFactory } from '../src/mcp.ts';
import { MEMBER_SESSIONS_CLOSE_MS } from '../src/relay.ts';
import {
  attachMember,
  call,
  type InviteRelay,
  type InviteRelayOptions,
  joinAtI,
  latest,
  mintOk,
  redeem,
  signedInAtI,
  startInviteRelay,
} from './helpers/invites.ts';
import { PAGE_ORIGIN, type TestPage } from './helpers/page-client.ts';
import { Phone } from './helpers/phone.ts';
import { PAIR_CLIENT, startProvider } from './helpers/provider.ts';
import { openListen } from './helpers/raw-mcp.ts';
import { delay, eventually } from './helpers/relay.ts';
import { leakIn } from './helpers/secrecy.ts';
import { waitState } from './helpers/state.ts';
import { PUBLIC_MCP_URL, PUBLIC_ORIGIN } from './helpers/tunnel.ts';

const ALICE = 'sub-alice=alice:Alice';
const BOB = 'sub-bob=bob:Bob';
/** Stands in for a token pasted into the file or its path: it must reach no refusal or line. */
const MARK = 'tabdock_sk_live_Zq7Mark0123456789abcdefghij';

const scratches: string[] = [];
const relays: InviteRelay[] = [];

afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close();
  for (const dir of scratches.splice(0)) {
    // A test may have left a directory others could write; it is ours to remove.
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A directory only this account can change, under the private scratch root (vitest.setup.ts). */
function privateDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tabdock-members-')));
  chmodSync(dir, 0o700);
  scratches.push(dir);
  return dir;
}

function text(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

/** As the guide says to save it: a new file renamed over the old, so no reader sees half of it. */
function save(file: string, lines: readonly string[]): void {
  const next = `${file}.new`;
  writeFileSync(next, text(lines), { mode: 0o600 });
  renameSync(next, file);
}

interface MembersRelay {
  relay: InviteRelay;
  file: string;
  save: (lines: readonly string[]) => void;
}

/**
 * A relay whose plugin lists Alice and Bob in code, as every invite test's
 * does, and whose members file lists `lines`: the file is read at start and
 * wins, so a test sees the file's list from the first request.
 */
async function membersRelay(
  lines: readonly string[],
  options: InviteRelayOptions = {},
): Promise<MembersRelay> {
  const file = join(privateDir(), 'members.txt');
  writeFileSync(file, text(lines), { mode: 0o600 });
  const relay = await startInviteRelay({ membersFile: file, ...options });
  relays.push(relay);
  return {
    relay,
    file,
    save: (next) => {
      save(file, next);
    },
  };
}

function linesOf(relay: InviteRelay): string {
  return relay.lines.join('\n');
}

function errorOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected a refusal');
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected a rejection');
}

function inviteeId(sub: string): string {
  return `${INVITEE_ID_PREFIX}${inviteeKeyOf(sub)}`;
}

/** Bob's call held unanswered by the page, so the change finds it in flight. */
async function heldCall(
  bob: Client,
  page: TestPage,
): Promise<{ answer: Promise<Awaited<ReturnType<typeof call>>>; callId: string }> {
  const answer = call(bob, 'call_page_tool', { page: page.pageId, tool: 'get_view' });
  const invoke = await page.next('invoke');
  expect(invoke.caller.userId).toBe('bob');
  return { answer, callId: invoke.callId };
}

describe('the members file at start (ADR 0043)', () => {
  /** Public URL mode's settings with the file in place of TABDOCK_OAUTH_USERS. */
  function env(file: string): Record<string, string> {
    return {
      TABDOCK_PUBLIC_URL: PUBLIC_ORIGIN,
      TABDOCK_OAUTH_ISSUER: 'https://idp.example',
      TABDOCK_MEMBERS_FILE: file,
      TABDOCK_PAIR_CLIENT_ID: PAIR_CLIENT.clientId,
      TABDOCK_PAIR_CLIENT_SECRET: PAIR_CLIENT.clientSecret,
      TABDOCK_ALLOWED_ORIGINS: PAGE_ORIGIN,
    };
  }
  function refused(file: string, words: string, extra: Record<string, string> = {}): void {
    const message = errorOf(() => resolveConfig(loadConfigFromEnv({ ...env(file), ...extra })));
    expect(message).toBe(words);
    expect(message).not.toContain(file);
    expect(leakIn(message, MARK)).toBeNull();
  }
  /** A private directory whose name holds the mark, as a path holding a pasted secret would. */
  function markedFile(lines: readonly string[] | null, mode = 0o600): string {
    const dir = join(privateDir(), MARK);
    mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, 'members.txt');
    if (lines !== null) {
      writeFileSync(file, text(lines), { mode });
      chmodSync(file, mode);
    }
    return file;
  }

  it("gives the plugin the file's members, read once at start", () => {
    const file = markedFile([ALICE, BOB]);
    const config = loadConfigFromEnv(env(file));
    expect(config.auth.members?.names()).toEqual(['Alice', 'Bob']);
    expect(config.auth.members?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(resolveConfig(config).membersFile).toBe(file);
  });

  it('refuses to start on a path or a file it cannot use, never repeating either', () => {
    refused('members.txt', 'TABDOCK_MEMBERS_FILE must be an absolute path (ADR 0043)');
    refused(markedFile(null), 'TABDOCK_MEMBERS_FILE names a file that does not exist (ADR 0043)');
    refused(markedFile(['# nobody']), 'TABDOCK_MEMBERS_FILE lists no members (ADR 0043)');
    refused(
      markedFile([ALICE, `${MARK} b=bob`]),
      'TABDOCK_MEMBERS_FILE line 2 has a sub that is not 1 to 255 printable characters',
    );
    refused(
      markedFile(Array.from({ length: MAX_MEMBERS + 1 }, (_, i) => `s${String(i)}=u${String(i)}`)),
      'TABDOCK_MEMBERS_FILE lists more than 500 members (ADR 0043)',
    );
    refused(
      markedFile([ALICE, `#${'x'.repeat(262_144)}`]),
      'TABDOCK_MEMBERS_FILE is larger than 262144 bytes (ADR 0043)',
    );
    const dir = markedFile(null).replace(/members\.txt$/, '');
    refused(
      dir,
      'TABDOCK_MEMBERS_FILE names something that is not a regular file once symbolic links are followed (ADR 0043)',
    );
    refused(
      markedFile([ALICE]),
      'TABDOCK_OAUTH_USERS and TABDOCK_MEMBERS_FILE both list members; keep one (ADR 0043)',
      { TABDOCK_OAUTH_USERS: 'sub-alice=alice' },
    );
    const noPublic = { ...env(markedFile([ALICE])), TABDOCK_PUBLIC_URL: '' };
    expect(errorOf(() => loadConfigFromEnv(noPublic))).toBe(
      'TABDOCK_MEMBERS_FILE lists the members OAuth signs in, which only public URL mode does; it works only with TABDOCK_PUBLIC_URL (ADR 0043)',
    );
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a file another account could change, through its mode, its directories or a symbolic link on the way',
    () => {
      refused(
        markedFile([ALICE], 0o620),
        "TABDOCK_MEMBERS_FILE names a file another account could change: the file itself can be written by other accounts (mode 620), and whoever can change it can make anyone a member; keep the file where only the relay's account and root can write it and every directory above it (ADR 0043)",
      );
      const shared = join(privateDir(), 'shared');
      mkdirSync(shared);
      chmodSync(shared, 0o777);
      const inShared = join(shared, 'members.txt');
      writeFileSync(inShared, text([ALICE]), { mode: 0o600 });
      refused(
        inShared,
        "TABDOCK_MEMBERS_FILE names a file another account could change: the directory holding it can be written by other accounts (mode 777), and whoever can change it can make anyone a member; keep the file where only the relay's account and root can write it and every directory above it (ADR 0043)",
      );
      // A link in a directory anyone can write could be pointed elsewhere, whatever it points to now.
      const good = markedFile([ALICE]);
      const link = join(shared, 'link.txt');
      symlinkSync(good, link);
      refused(
        link,
        "TABDOCK_MEMBERS_FILE names a file another account could change: a directory a symbolic link on the way to it lies in, or one above that, can be written by other accounts (mode 777), and whoever can change it can make anyone a member; keep the file where only the relay's account and root can write it and every directory above it (ADR 0043)",
      );
      // A link kept privately is followed, to a file kept privately.
      const privateLink = join(privateDir(), 'members.txt');
      symlinkSync(good, privateLink);
      expect(loadConfigFromEnv(env(privateLink)).auth.members?.names()).toEqual(['Alice']);
    },
  );

  it('is counted in the banner, never named', async () => {
    const provider = await startProvider();
    try {
      const file = markedFile([ALICE, BOB]);
      const started = await startFromEnv(
        {
          packaged: false,
          env: { ...env(file), TABDOCK_OAUTH_ISSUER: provider.issuer, TABDOCK_PORT: '0' },
          platform: process.platform,
          out: () => undefined,
          err: () => undefined,
        },
        { newToken: false },
      );
      try {
        expect(started.lines).toContain(
          '  Members from TABDOCK_MEMBERS_FILE (2), read again when it changes',
        );
        expect(started.lines.join('\n')).not.toContain(file);
        expect(leakIn(started.lines.join('\n'), MARK)).toBeNull();
      } finally {
        await started.relay.close();
      }
    } finally {
      await provider.stop();
    }
  });

  it('is read again as the relay starts, so a list given in code yields to the file', async () => {
    const { relay } = await membersRelay([ALICE], { invites: false });
    // The helper's plugin lists Bob in code; the file does not, so Bob is no member.
    const bob = relay.claude('sub-bob');
    expect(await rejection(bob)).toMatch(/./);
    const missing = join(privateDir(), 'gone.txt');
    const started = startInviteRelay({ membersFile: missing });
    expect(await rejection(started)).toBe(
      'TABDOCK_MEMBERS_FILE names a file that does not exist (ADR 0043)',
    );
  });
});

describe('a member added to the file (ADR 0043)', () => {
  it('pairs without a restart, while every other attachment, page and invite link stays', async () => {
    const { relay, save: saveMembers } = await membersRelay([ALICE]);
    const page = await relay.page();
    const alice = await relay.claude('sub-alice');
    await attachMember(alice, page);
    const invite = await mintOk(page, { uses: 5 });
    // Before the change Bob is an invitee, whom only an invite lets in.
    const before = await relay.claude('sub-bob', 'bob@example.com');
    expect((await call(before, 'pair_page', { code: page.code })).text).toMatch(
      /^invite_required: /,
    );
    saveMembers([ALICE, BOB]);
    expect(await relay.relay.reloadMembers()).toBe('applied');
    expect(await relay.relay.reloadMembers()).toBe('unchanged');
    const bob = await relay.claude('sub-bob');
    await attachMember(bob, page);
    const roster = await latest(page, 'roster');
    expect(roster.attachments.map((attachment) => attachment.userId).sort()).toEqual([
      'alice',
      'bob',
    ]);
    expect(
      (await call(alice, 'call_page_tool', { page: page.pageId, tool: 'get_view' })).isError,
    ).toBe(false);
    expect((await latest(page, 'invites')).invites.map((listed) => listed.inviteId)).toEqual([
      invite.inviteId,
    ]);
    expect(relay.relay.audit.events()).toContainEqual(
      expect.objectContaining({
        type: 'members_reloaded',
        members: 2,
        added: ['bob'],
        removed: [],
        renamed: 0,
        attachments: 0,
      }),
    );
  });

  it('is read on its own within two polls, with no reloadMembers', async () => {
    const { relay, save: saveMembers } = await membersRelay([ALICE], {
      timings: { membersPollMs: 50 },
    });
    saveMembers([ALICE, BOB]);
    await eventually(() => linesOf(relay).includes('"msg":"members reloaded"'), 2000);
    const page = await relay.page();
    await attachMember(await relay.claude('sub-bob'), page);
  });

  it('pairs within 4 s at the default poll (A6.14)', { timeout: 15_000 }, async () => {
    // Timers run late on a loaded machine, and the reload waits on two polls;
    // this is all the lateness the bound allows them between them.
    const LATE_TIMERS_MS = 500;
    const { relay, save: saveMembers } = await membersRelay([ALICE]);
    const page = await relay.page();
    const savedAt = Date.now();
    saveMembers([ALICE, BOB]);
    await eventually(
      () => linesOf(relay).includes('"msg":"members reloaded"'),
      2 * MEMBERS_POLL_MS + 2000,
    );
    // A changed stat waits one poll and is read at the next, so two polls at most.
    expect(2 * MEMBERS_POLL_MS).toBe(4000);
    const reloaded = relay.events().find((line) => line.msg === 'members reloaded');
    const reloadMs = Date.parse(String(reloaded?.ts)) - savedAt;
    expect(reloadMs).toBeLessThanOrEqual(2 * MEMBERS_POLL_MS + LATE_TIMERS_MS);
    // Then Bob pairs, in the client's round trips and the operator's answer,
    // which the reload's bound leaves out.
    const bob = await relay.claude('sub-bob');
    await attachMember(bob, page);
    // The session Bob paired on outlives the moment after the change.
    await new Promise((resolve) => setTimeout(resolve, MEMBER_SESSIONS_CLOSE_MS + 500));
    expect(
      (await call(bob, 'call_page_tool', { page: page.pageId, tool: 'get_view' })).isError,
    ).toBe(false);
  });
});

describe('a member removed from the file (S8)', () => {
  it('loses every attachment at once, the call in flight cancelled, with an audit record', async () => {
    const { relay, save: saveMembers } = await membersRelay([ALICE, BOB], { invites: false });
    const page = await relay.page({
      onInvoke: (frame) =>
        frame.caller.userId === 'bob' ? undefined : { ok: true, content: '{}' },
    });
    const alice = await relay.claude('sub-alice');
    const bob = await relay.claude('sub-bob');
    await attachMember(alice, page);
    await attachMember(bob, page);
    const held = await heldCall(bob, page);
    saveMembers([ALICE]);
    expect(await relay.relay.reloadMembers()).toBe('applied');
    expect(await page.next('cancel')).toEqual({
      t: 'cancel',
      callId: held.callId,
      reason: 'revoked',
    });
    expect((await held.answer).text).toMatch(
      /^not_attached: your membership on this relay changed/,
    );
    expect((await latest(page, 'roster')).attachments.map((a) => a.userId)).toEqual(['alice']);
    const events = relay.relay.audit.events();
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'expire', userId: 'bob', reason: 'membership_changed' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'members_reloaded', removed: ['bob'], attachments: 1 }),
    );
    // With invites off, Bob is now a stranger the relay answers 403.
    expect(await rejection(relay.claude('sub-bob'))).toMatch(/not allowed on this relay/);
    expect(
      (await call(alice, 'call_page_tool', { page: page.pageId, tool: 'get_view' })).isError,
    ).toBe(false);
  });

  // W1-C's waits meet W1-E's reload here: S8 says a member's removal ends a
  // waiting wait_for_page_state as a revoke does, not at its timeout.
  it(
    'loses a waiting wait_for_page_state at once, while a kept member waits on',
    { timeout: 15_000 },
    async () => {
      const { relay, save: saveMembers } = await membersRelay([ALICE, BOB], { invites: false });
      const page = await relay.page();
      const alice = await relay.claude('sub-alice');
      const bob = await relay.claude('sub-bob');
      await attachMember(alice, page);
      await attachMember(bob, page);
      const waitsStarted = (): number =>
        relay.lines.filter((line) => line.includes('"msg":"page state wait started"')).length;
      const startedAt = Date.now();
      const bobWaits = waitState(bob, page.pageId, 0, 4000);
      // A wait the change missed may never answer; this test reports that itself.
      bobWaits.catch(() => undefined);
      await eventually(() => waitsStarted() === 1);
      const aliceWaits = waitState(alice, page.pageId, 0, 1500);
      await eventually(() => waitsStarted() === 2);
      saveMembers([ALICE]);
      expect(await relay.relay.reloadMembers()).toBe('applied');
      // Well before its own 4 s timeout, and before the reload closes Bob's
      // session, which would leave a wait the change missed unanswered.
      const bobs = await Promise.race([bobWaits, delay(2000).then(() => null)]);
      if (bobs === null) throw new Error("Bob's wait still waits 2 s after the change");
      expect(bobs.isError).toBe(true);
      expect(bobs.text).toMatch(/^not_attached: your membership on this relay changed/);
      expect(Date.now() - startedAt).toBeLessThan(3000);
      // Alice's wait runs to its own timeout and answers with no change.
      const alices = await aliceWaits;
      expect(alices.isError, alices.text).toBe(false);
      expect(alices.body).toMatchObject({ page: page.pageId, version: 0, changed: false });
    },
  );

  it('with invites on, sees no page, and loses a request waiting on the operator', async () => {
    const { relay, save: saveMembers } = await membersRelay([ALICE, BOB]);
    const page = await relay.page();
    const bob = await relay.claude('sub-bob');
    const pending = call(bob, 'pair_page', { code: page.code });
    await page.next('attach_request');
    saveMembers([ALICE]);
    await relay.relay.reloadMembers();
    expect((await pending).text).toMatch(/^pairing_expired: your membership on this relay changed/);
    const after = await relay.claude('sub-bob', 'bob@example.com');
    expect((await call(after, 'list_pages')).structured).toEqual({ pages: [] });
    expect(relay.relay.audit.events()).toContainEqual(
      expect.objectContaining({
        type: 'attach_refused',
        userId: 'bob',
        outcome: 'pairing_expired',
      }),
    );
  });

  it('closes the invites a removed sponsor shared, and detaches those they let in', async () => {
    const { relay, save: saveMembers } = await membersRelay([ALICE, BOB]);
    const page = await relay.page();
    const alice = await relay.claude('sub-alice');
    await attachMember(alice, page);
    const invite = await mintOk(page);
    const live = await mintOk(page, { uses: 5 });
    const guest = await relay.claude('sub-carol', 'carol@example.com');
    // pair_page takes a single-use invite, and the operator answers it.
    expect((await redeem(guest, page, invite.link)).outcome.isError).toBe(false);
    expect((await latest(page, 'invites')).invites.map((listed) => listed.inviteId)).toEqual([
      live.inviteId,
    ]);
    saveMembers([BOB]);
    await relay.relay.reloadMembers();
    expect((await latest(page, 'roster')).attachments).toEqual([]);
    expect((await latest(page, 'invites')).invites).toEqual([]);
    const events = relay.relay.audit.events();
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'invite_closed', reason: 'sponsor_gone' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'expire',
        userId: inviteeId('sub-carol'),
        reason: 'sponsor_gone',
      }),
    );
    expect((await call(guest, 'list_pages')).structured).toEqual({ pages: [] });
  });

  it('signs out its /pair browser, and closes its 2025-era session and listen stream', async () => {
    const { relay, save: saveMembers } = await membersRelay([ALICE, BOB]);
    const page = await relay.page();
    relay.provider.signInSubject = 'sub-bob';
    const phone = new Phone(relay.relay.url);
    try {
      await phone.signIn();
    } finally {
      relay.provider.signInSubject = null;
    }
    expect((await phone.preview(page.nonce)).data.account).toMatchObject({
      signedIn: true,
      member: true,
    });
    const bob = await relay.claude('sub-bob');
    expect((await call(bob, 'list_pages')).isError).toBe(false);
    const token = await relay.provider.token({ sub: 'sub-bob', aud: PUBLIC_MCP_URL });
    const user: DevTokenUser = { userId: 'bob', displayName: 'Bob', token };
    const listen = await openListen(relay.relay, user);
    expect(listen.streaming).toBe(true);
    saveMembers([ALICE]);
    await relay.relay.reloadMembers();
    expect((await phone.preview(page.nonce)).data.account).toEqual({ signedIn: false });
    await eventually(
      () => linesOf(relay).includes('sessions closed for a member list change'),
      3000,
    );
    await listen.ended;
    const closed = relay
      .events()
      .find((line) => line.msg === 'sessions closed for a member list change');
    expect(closed).toMatchObject({ mcpSessions: 1, streams: 1 });
    // Its session id now answers 404, as an unknown one does.
    expect(await rejection(call(bob, 'list_pages'))).toMatch(/404|not found/i);
  });
});

/**
 * A POST from a signed-in browser that sends its headers now and its body
 * when `send` is called, as a browser on a slow link may: the relay looks the
 * sign-in up before it reads the body.
 */
async function heldPost(
  phone: Phone,
  relayUrl: string,
  path: string,
  json: unknown,
): Promise<{ send: () => Promise<{ status: number; data: Record<string, unknown> }> }> {
  const body = JSON.stringify(json);
  const held: (() => void)[] = [];
  const answer = new Promise<{ status: number; data: Record<string, unknown> }>(
    (resolve, reject) => {
      const req = httpRequest(
        new URL(path, relayUrl),
        {
          method: 'POST',
          headers: {
            Host: new URL(PUBLIC_ORIGIN).host,
            Origin: PUBLIC_ORIGIN,
            Cookie: [...phone.cookies].map(([name, value]) => `${name}=${value}`).join('; '),
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(body)),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              data: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
            });
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.flushHeaders();
      held.push(() => {
        req.end(body);
      });
    },
  );
  // Long enough for the relay to take the headers and look the sign-in up.
  await new Promise((resolve) => setTimeout(resolve, 100));
  return {
    send: () => {
      for (const end of held) end();
      return answer;
    },
  };
}

describe('a change whose settling fails part way (S8)', () => {
  it('still runs every other step, and settles the change again with the next read', async () => {
    // An audit log that fails on the reload's record, which the hub writes last.
    const store = createMemoryStore();
    const audit = store.audit;
    let failing = true;
    store.audit = {
      append: (event) => {
        if (event.type === 'members_reloaded' && failing) {
          failing = false;
          throw new Error('the audit disk is gone');
        }
        return audit.append(event);
      },
      records: () => audit.records(),
    };
    const { relay, save: saveMembers } = await membersRelay([ALICE, BOB], {
      store,
      timings: { membersPollMs: 60_000 },
    });
    const page = await relay.page();
    relay.provider.signInSubject = 'sub-bob';
    const phone = new Phone(relay.relay.url);
    try {
      await phone.signIn();
    } finally {
      relay.provider.signInSubject = null;
    }
    const bob = await relay.claude('sub-bob');
    await attachMember(bob, page);
    saveMembers([ALICE]);
    expect(await rejection(relay.relay.reloadMembers())).toBe('the audit disk is gone');
    // The steps after the hub's ran: the sign-in and the session ended.
    expect((await phone.preview(page.nonce)).data.account).toEqual({ signedIn: false });
    await eventually(() =>
      relay
        .events()
        .some((line) => line.msg === 'MCP session closed' && line.reason === 'membership changed'),
    );
    // The same text read again settles what the failed one owed.
    expect(await relay.relay.reloadMembers()).toBe('applied');
    expect(relay.relay.audit.events()).toContainEqual(
      expect.objectContaining({ type: 'members_reloaded', removed: ['bob'], attachments: 0 }),
    );
    expect(await relay.relay.reloadMembers()).toBe('unchanged');
  });
});

describe('a sign-in a change ends while its request is on the way (S8)', () => {
  it('refuses the claim or status whose body arrives after the change, at /pair and /i', async () => {
    const { relay, save: saveMembers } = await membersRelay([ALICE, BOB]);
    const page = await relay.page();
    const alice = await relay.claude('sub-alice');
    await attachMember(alice, page);
    const invite = await mintOk(page, { uses: 3 });
    relay.provider.signInSubject = 'sub-bob';
    const bobPhone = new Phone(relay.relay.url);
    try {
      await bobPhone.signIn();
    } finally {
      relay.provider.signInSubject = null;
    }
    const first = await bobPhone.claim(page.nonce);
    expect(first.status).toBe(200);
    await page.next('attach_request');
    const carolPhone = await signedInAtI(relay, 'sub-carol', 'carol@example.com');
    const status = await heldPost(bobPhone, relay.relay.url, '/pair/status', {
      claim: first.data.claim,
    });
    await page.sync();
    const claim = await heldPost(bobPhone, relay.relay.url, '/pair/claim', { nonce: page.nonce });
    const join = await heldPost(carolPhone, relay.relay.url, '/i/claim', {
      secret: invite.secret,
    });
    // Bob leaves, and Carol's subject becomes a member under an id of its own.
    saveMembers([ALICE, 'sub-carol=carol:Carol']);
    expect(await relay.relay.reloadMembers()).toBe('applied');
    for (const answer of [await status.send(), await claim.send(), await join.send()]) {
      expect(answer).toEqual({
        status: 401,
        data: expect.objectContaining({ error: 'sign_in_required' }) as unknown,
      });
    }
    // Alice's by code and Bob's first by QR, and nothing raised after the change.
    expect(page.all('attach_request').map((frame) => [frame.user.userId, frame.via])).toEqual([
      ['alice', 'code'],
      ['bob', 'qr'],
    ]);
  });
});

/** The plugin's line for a token session it has not seen before, written as it checks the token. */
const FIRST_SIGHTING = '"msg":"oauth token shape, first sighting of its session"';

/**
 * A fetch for a 2026-07-28 client that sends the next tools/call naming
 * `tool` with its headers at once and its body only when `send` is called,
 * as a client on a slow link may: the relay signs /mcp requests in from the
 * headers, before it reads the body. Every other request passes untouched.
 * The held request carries a token of its own, for `sub` with a session id
 * no other has, so `signedIn` resolves once the plugin's first sighting of
 * it shows the relay has checked it and mapped `sub` as the list said then.
 */
function heldMcp(
  relay: InviteRelay,
  sub: string,
  tool: string,
): { wrap: (base: FetchLike) => FetchLike; signedIn: Promise<void>; send: () => void } {
  const sightings = (): number =>
    relay.lines.filter((line) => line.includes(FIRST_SIGHTING)).length;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sent!: () => void;
  const headersSent = new Promise<void>((resolve) => {
    sent = resolve;
  });
  let armed = true;
  let seen = 0;
  const wrap =
    (base: FetchLike): FetchLike =>
    (input, init) => {
      const body = typeof init?.body === 'string' ? init.body : undefined;
      if (!armed || body === undefined || !body.includes(`"name":"${tool}"`)) {
        return base(input, init);
      }
      armed = false;
      const url = new URL(String(input));
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      return new Promise<Response>((resolve, reject) => {
        const send = (token: string): void => {
          const req = httpRequest(
            new URL(`${url.pathname}${url.search}`, relay.relay.url),
            {
              method: 'POST',
              headers: {
                ...headers,
                authorization: `Bearer ${token}`,
                host: new URL(PUBLIC_ORIGIN).host,
                'content-length': String(Buffer.byteLength(body)),
              },
            },
            (res) => {
              resolve(
                new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
                  status: res.statusCode ?? 0,
                  headers: Object.entries(res.headers).flatMap(([name, value]) =>
                    value === undefined
                      ? []
                      : (Array.isArray(value) ? value : [value]).map((each): [string, string] => [
                          name,
                          each,
                        ]),
                  ),
                }),
              );
            },
          );
          req.on('error', reject);
          req.flushHeaders();
          sent();
          void released.then(() => req.end(body));
        };
        relay.provider
          .token({ sub, aud: PUBLIC_MCP_URL, sid: `held-${randomUUID()}` })
          .then((token) => {
            seen = sightings();
            send(token);
          }, reject);
      });
    };
  const signedIn = headersSent.then(() => eventually(() => sightings() > seen, 5000));
  return { wrap, signedIn, send: release };
}

/** A call's answer, or its rejection's message, whichever it comes to. */
async function settled(
  pending: Promise<Awaited<ReturnType<typeof call>>>,
): Promise<{ isError: boolean; text: string }> {
  try {
    return await pending;
  } catch (error) {
    return { isError: true, text: error instanceof Error ? error.message : String(error) };
  }
}

describe('a /mcp request a change ends while its body is on the way (S8, S13)', () => {
  it('raises no pairing request under a removed member, by code', async () => {
    const { relay, save: saveMembers } = await membersRelay([ALICE, BOB]);
    const page = await relay.page();
    const held = heldMcp(relay, 'sub-alice', 'pair_page');
    const alice = await relay.claude('sub-alice', null, true, held.wrap, true);
    const pending = settled(call(alice, 'pair_page', { code: page.code }));
    await held.signedIn;
    saveMembers([BOB]);
    expect(await relay.relay.reloadMembers()).toBe('applied');
    held.send();
    const outcome = await pending;
    // The plugin's 401, so the client signs in again as the list now says.
    expect(outcome).toEqual({
      isError: true,
      text: expect.stringMatching(/unauthorized/i) as unknown,
    });
    await page.sync();
    expect(page.all('attach_request').map((frame) => frame.user.userId)).not.toContain('alice');
    expect(relay.store.attachments.listForPage(page.pageId)).toEqual([]);
    expect(linesOf(relay)).toContain('a member list change ended its sign-in');
  });

  it('redeems no invite for a removed member, leaving its use for someone else', async () => {
    const { relay, save: saveMembers } = await membersRelay([ALICE, BOB]);
    const page = await relay.page();
    const bob = await relay.claude('sub-bob');
    await attachMember(bob, page);
    const invite = await mintOk(page, { role: 'observer', uses: 1 });
    const held = heldMcp(relay, 'sub-alice', 'pair_page');
    const alice = await relay.claude('sub-alice', null, true, held.wrap, true);
    const pending = settled(call(alice, 'pair_page', { invite: invite.link }));
    await held.signedIn;
    saveMembers([BOB]);
    expect(await relay.relay.reloadMembers()).toBe('applied');
    held.send();
    expect((await pending).isError).toBe(true);
    await page.sync();
    expect(page.all('attach_request').map((frame) => frame.user.userId)).toEqual(['bob']);
    expect((await latest(page, 'invites')).invites.map((listed) => listed.inviteId)).toEqual([
      invite.inviteId,
    ]);
  });

  it('runs no call under an id the file gave someone else, who attached under it meanwhile', async () => {
    const { relay, save: saveMembers } = await membersRelay([ALICE, BOB]);
    const page = await relay.page();
    const held = heldMcp(relay, 'sub-alice', 'call_page_tool');
    const alice = await relay.claude('sub-alice', null, true, held.wrap, true);
    await attachMember(alice, page);
    const pending = settled(call(alice, 'call_page_tool', { page: page.pageId, tool: 'get_view' }));
    await held.signedIn;
    // The id alice now names Carol, who pairs under it before Alice's body arrives.
    saveMembers(['sub-carol=alice:Carol', BOB]);
    expect(await relay.relay.reloadMembers()).toBe('applied');
    const carol = await relay.claude('sub-carol');
    await attachMember(carol, page);
    held.send();
    expect((await pending).isError).toBe(true);
    await page.sync();
    expect(page.all('invoke')).toEqual([]);
  });

  it('is refused again as a tool handler starts, after the awaits between the body and the hub', async () => {
    // relay.ts refuses such a request once its body is read; the SDK's own
    // awaits (a request state's MAC among them) lie between that and a
    // handler, so the dispatcher asks again before it reaches the hub.
    const config = resolveConfig({
      auth: createDevTokenAuth([{ userId: 'alice', displayName: 'Alice', token: 't'.repeat(32) }]),
    });
    const reached: string[] = [];
    const hub = new Proxy(
      {},
      {
        get(_target, key) {
          if (key === 'then') return undefined;
          return () => {
            reached.push(String(key));
            throw new Error(`the hub was reached through ${String(key)}`);
          };
        },
      },
    ) as unknown as PageHub;
    const authInfo: AuthInfo = {
      token: '',
      clientId: 'alice',
      scopes: [],
      extra: {
        userId: 'alice',
        displayName: 'Alice',
        kind: 'member',
        email: null,
        oauthClientId: null,
      },
    };
    const handler = createMcpHandler(
      createMcpFactory(hub, config, { signInEnded: (auth) => auth === authInfo }),
    );
    try {
      const response = await handler.fetch(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'Mcp-Protocol-Version': '2026-07-28',
            'Mcp-Method': 'tools/call',
            'Mcp-Name': 'pair_page',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'pair_page',
              arguments: { code: 'ABCD-EFGH' },
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': { name: 'x', version: '1' },
                'io.modelcontextprotocol/clientCapabilities': {},
              },
            },
          }),
        }),
        { authInfo },
      );
      const text = await response.text();
      expect(text).toContain('your membership on this relay changed');
      expect(reached).toEqual([]);
    } finally {
      await handler.close();
    }
  });
});

describe('a user id the file moves (S13)', () => {
  it("shows the new holder none of the former holder's pages, gone ones included", async () => {
    const { relay, save: saveMembers } = await membersRelay([ALICE, BOB], {
      timings: { resumeWindowMs: 200 },
    });
    const live = await relay.page();
    const leaving = await relay.page({ title: 'Leaving' });
    const alice = await relay.claude('sub-alice');
    await attachMember(alice, live);
    await attachMember(alice, leaving);
    leaving.ws.close(4000, 'detach');
    await eventually(async () => {
      const listed = (await call(alice, 'list_pages')).structured as { pages: { state: string }[] };
      return listed.pages.some((listing) => listing.state === 'gone');
    });
    // Another subject now takes the id alice, and the first is no member.
    saveMembers(['sub-other=alice:Alice', BOB]);
    await relay.relay.reloadMembers();
    const other = await relay.claude('sub-other');
    expect((await call(other, 'list_pages')).structured).toEqual({ pages: [] });
    expect((await latest(live, 'roster')).attachments).toEqual([]);
  });
});

describe('what a reload leaves alone (ADR 0043)', () => {
  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  /** Whether a listen stream is still open after `ms`. */
  async function openAfter(listen: { ended: Promise<void> }, ms: number): Promise<boolean> {
    return Promise.race([listen.ended.then(() => false), pause(ms).then(() => true)]);
  }

  it('keeps the session and listen stream a member added by it opens at once', async () => {
    const { relay, save: saveMembers } = await membersRelay([ALICE], { invites: false });
    const page = await relay.page();
    saveMembers([ALICE, BOB]);
    expect(await relay.relay.reloadMembers()).toBe('applied');
    // In the first moment after the change, as a member who kept retrying would.
    const bob = await relay.claude('sub-bob');
    await attachMember(bob, page);
    const token = await relay.provider.token({ sub: 'sub-bob', aud: PUBLIC_MCP_URL });
    const listen = await openListen(relay.relay, { userId: 'bob', displayName: 'Bob', token });
    expect(listen.streaming).toBe(true);
    expect(await openAfter(listen, MEMBER_SESSIONS_CLOSE_MS + 500)).toBe(true);
    expect(
      (await call(bob, 'call_page_tool', { page: page.pageId, tool: 'get_view' })).isError,
    ).toBe(false);
    expect(linesOf(relay)).not.toContain('membership changed');
    listen.close();
  });

  it("ends the former holder's session of a reused id, and keeps the new holder's", async () => {
    const { relay, save: saveMembers } = await membersRelay([ALICE, BOB]);
    const page = await relay.page();
    const former = await relay.claude('sub-bob');
    expect((await call(former, 'list_pages')).isError).toBe(false);
    // Another subject now takes the id bob.
    saveMembers([ALICE, 'sub-other=bob:Bob']);
    expect(await relay.relay.reloadMembers()).toBe('applied');
    const holder = await relay.claude('sub-other');
    await attachMember(holder, page);
    await pause(MEMBER_SESSIONS_CLOSE_MS + 500);
    expect(
      (await call(holder, 'call_page_tool', { page: page.pageId, tool: 'get_view' })).isError,
    ).toBe(false);
    expect(await rejection(call(former, 'list_pages'))).toMatch(/404|not found/i);
    const closed = relay
      .events()
      .filter((line) => line.msg === 'MCP session closed' && line.reason === 'membership changed');
    expect(closed).toHaveLength(1);
  });

  it('lets the answer it gave a call in flight reach that call, then ends the session', async () => {
    const { relay, save: saveMembers } = await membersRelay([ALICE, BOB]);
    const page = await relay.page({
      onInvoke: (frame) =>
        frame.caller.userId === 'bob' ? undefined : { ok: true, content: '{}' },
    });
    const bob = await relay.claude('sub-bob');
    await attachMember(bob, page);
    const held = await heldCall(bob, page);
    saveMembers([ALICE]);
    expect(await relay.relay.reloadMembers()).toBe('applied');
    // The answer the change gave the call in flight still reaches it on its session.
    expect((await held.answer).text).toMatch(/^not_attached: /);
    await eventually(() =>
      relay
        .events()
        .some((line) => line.msg === 'MCP session closed' && line.reason === 'membership changed'),
    );
    expect(await rejection(call(bob, 'list_pages'))).toMatch(/404|not found/i);
  });
});

describe('a renamed member (ADR 0043)', () => {
  it('keeps everything under the new name, and an invitee whose name now reads as theirs shows its short id', async () => {
    const { relay, save: saveMembers } = await membersRelay([ALICE, BOB]);
    const page = await relay.page();
    const alice = await relay.claude('sub-alice');
    await attachMember(alice, page);
    const invite = await mintOk(page, { uses: 3 });
    const phone = await signedInAtI(relay, 'sub-carol', 'teacher@example.com');
    await joinAtI(phone, page, invite.secret);
    saveMembers(['sub-alice=alice:Teacher@Example.com', BOB]);
    await relay.relay.reloadMembers();
    const roster = (await latest(page, 'roster')).attachments;
    const carol = inviteeId('sub-carol');
    expect(roster.map((attachment) => [attachment.userId, attachment.displayName])).toEqual([
      ['alice', 'Teacher@Example.com'],
      [
        carol,
        `invitee ${carol.slice(INVITEE_ID_PREFIX.length, INVITEE_ID_PREFIX.length + INVITEE_SHORT_ID_CHARS)}`,
      ],
    ]);
    expect(
      (await call(alice, 'call_page_tool', { page: page.pageId, tool: 'get_view' })).isError,
    ).toBe(false);
    expect(relay.relay.audit.events()).toContainEqual(
      expect.objectContaining({ type: 'members_reloaded', renamed: 1, attachments: 0 }),
    );
  });

  it('names a browser signed in before it as a sign-in would now, at /i and at /pair', async () => {
    const { relay, save: saveMembers } = await membersRelay([ALICE, BOB]);
    const page = await relay.page();
    const alice = await relay.claude('sub-alice');
    await attachMember(alice, page);
    const invite = await mintOk(page, { uses: 3 });
    // Both sign in while the list still says Alice and Bob.
    const carolPhone = await signedInAtI(relay, 'sub-carol', 'teacher@example.com');
    relay.provider.signInSubject = 'sub-bob';
    const bobPhone = new Phone(relay.relay.url);
    try {
      await bobPhone.signIn();
    } finally {
      relay.provider.signInSubject = null;
    }
    saveMembers(['sub-alice=alice:Teacher@Example.com', 'sub-bob=bob:Robert']);
    expect(await relay.relay.reloadMembers()).toBe('applied');
    const carol = inviteeId('sub-carol');
    const short = `invitee ${carol.slice(INVITEE_ID_PREFIX.length, INVITEE_ID_PREFIX.length + INVITEE_SHORT_ID_CHARS)}`;
    expect((await joinAtI(carolPhone, page, invite.secret)).request.user.displayName).toBe(short);
    expect((await bobPhone.preview(page.nonce)).data.account).toMatchObject({
      displayName: 'Robert',
    });
    const claimed = await bobPhone.claim(page.nonce);
    expect(claimed.status, JSON.stringify(claimed.data)).toBe(200);
    expect((await page.next('attach_request')).user.displayName).toBe('Robert');
  });
});

describe('a file the relay cannot use at reload (ADR 0043)', () => {
  it('keeps the list in force, warning once per problem by line number alone', async () => {
    const { relay, file, save: saveMembers } = await membersRelay([ALICE, BOB]);
    const page = await relay.page();
    const bob = await relay.claude('sub-bob');
    await attachMember(bob, page);
    const keeps = async (): Promise<void> => {
      expect(
        (await call(bob, 'call_page_tool', { page: page.pageId, tool: 'get_view' })).isError,
      ).toBe(false);
    };
    saveMembers([ALICE, MARK]);
    expect(await relay.relay.reloadMembers()).toBe('refused');
    expect(await relay.relay.reloadMembers()).toBe('refused');
    await keeps();
    saveMembers(['# everyone left']);
    expect(await relay.relay.reloadMembers()).toBe('refused');
    await keeps();
    unlinkSync(file);
    expect(await relay.relay.reloadMembers()).toBe('refused');
    await keeps();
    if (process.platform !== 'win32') {
      writeFileSync(file, text([ALICE]), { mode: 0o600 });
      chmodSync(file, 0o660);
      expect(await relay.relay.reloadMembers()).toBe('refused');
      await keeps();
    }
    const warnings = relay
      .events()
      .filter((line) => line.msg === 'members file refused; keeping the list read last');
    expect(warnings.map((line) => [line.problem, line.line])).toEqual([
      ['malformed', 2],
      ['empty', null],
      ['missing', null],
      ...(process.platform === 'win32' ? [] : [['unsafe', null]]),
    ]);
    expect(leakIn(linesOf(relay), MARK)).toBeNull();
    expect(linesOf(relay)).not.toContain(file);
    // Fixed, the next read applies it.
    chmodSync(file, 0o600);
    expect(await relay.relay.reloadMembers()).toBe('applied');
  });
});

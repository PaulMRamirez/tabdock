// A6.18, the restart snapshot (ADR 0046). With TABDOCK_RESTART_SNAPSHOT on,
// a graceful stop writes the hub's store to one 0600 file in the audit
// directory and its SHA-256 to a snapshot_written record that relay_stop
// follows, and the next start puts it back: the page resumes with its
// attachments, live invites, time-boxed session and agent tokens. Each start
// removes the file before it decides anything, so a snapshot is used at most
// once; it loads only when the log's last two lines bind it to the stop that
// wrote it, so a tampered, replayed or planted file never does, nor one past
// the resume window, from the future, from another mode or reached through a
// link. A member the list in force no longer gives the same subject comes
// back with nothing, and what they sponsored goes with them (S8, S13, S14).
// A revoked attachment or a closed invite never returns. The file holds
// digests only: no resume token, invite secret, agent token, pairing code or
// subject. With the setting off nothing is written, a file an earlier run
// left is removed unread, and a restart ends everything, as in M5. Against a
// public URL relay and the stand-in provider, each test restarting a real
// relay on one audit directory; the page is the test's own stand-in.

import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  AUDIT_VERSION,
  type AuditLine,
  INVITEE_ID_PREFIX,
  type PolicyInput,
  PolicySchema,
  type RelaySnapshot,
  RelaySnapshotSchema,
  RESUME_WINDOW_MS,
  SNAPSHOT_VERSION,
} from '@tabdock/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../src/config.ts';
import { PageHub } from '../src/hub.ts';
import {
  createDevTokenAuth,
  createLogger,
  createMemoryStore,
  createOAuthAuth,
  createRelay,
  inviteeKeyOf,
  lineHash,
  type OAuthUser,
  readAuditLines,
  type Relay,
  type RelayOptions,
} from '../src/index.ts';
import {
  bindingProblem,
  SNAPSHOT_FILE,
  type SnapshotFs,
  snapshotAccounts,
  takeSnapshot,
  writeSnapshot,
} from '../src/snapshot.ts';
import { agentUserId, connectAgent, mintAgent } from './helpers/agents.ts';
import {
  attachMember,
  call,
  emailClaims,
  latest,
  MEMBERS,
  mintOk,
  redeem,
} from './helpers/invites.ts';
import {
  connectPage,
  PAGE_ORIGIN,
  type PageOptions,
  type TestPage,
  TOOLS,
} from './helpers/page-client.ts';
import { PAIR_CLIENT, startProvider, type TestProvider } from './helpers/provider.ts';
import { ALICE as DEV_ALICE, FAST_TIMINGS } from './helpers/relay.ts';
import { PUBLIC_MCP_URL, PUBLIC_ORIGIN, tunnelFetch } from './helpers/tunnel.ts';

const MINUTE = 60_000;
const GUEST = 'sub-guest';
const GUEST_EMAIL = 'guest@example.com';
const POLICY: PolicyInput = { invites: 'all', maxDrivers: 2, proposals: 'members' };

interface Run {
  relay: Relay;
  lines: string[];
  page(options?: PageOptions): Promise<TestPage>;
  claude(sub: string, email?: string | null): Promise<Client>;
  close(): Promise<void>;
}

const runs: Run[] = [];
const providers: TestProvider[] = [];
const scratches: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const run of runs.splice(0)) await run.close();
  for (const provider of providers.splice(0)) await provider.stop().catch(() => undefined);
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A directory only this account can change, under the private scratch root (vitest.setup.ts). */
function privateDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tabdock-snapshot-')));
  chmodSync(dir, 0o700);
  scratches.push(dir);
  return dir;
}

/** An audit directory the relay makes itself, as it makes TABDOCK_AUDIT_DIR. */
function auditDir(): string {
  return join(privateDir(), 'audit');
}

async function provider(): Promise<TestProvider> {
  const started = await startProvider();
  providers.push(started);
  return started;
}

interface RunOptions extends Partial<RelayOptions> {
  users?: OAuthUser[];
}

/**
 * A public URL relay with invites, agent tokens and the snapshot on, its
 * audit log in `dir`, signing people in at `idp`, which outlives it, so a
 * client signs in again at the next relay as the same person.
 */
async function startRun(dir: string, idp: TestProvider, options: RunOptions = {}): Promise<Run> {
  const lines: string[] = [];
  const { users, ...rest } = options;
  const relay = await createRelay({
    auth: createOAuthAuth({
      issuer: idp.issuer,
      resource: PUBLIC_MCP_URL,
      users: users ?? MEMBERS,
    }),
    publicUrl: PUBLIC_ORIGIN,
    pairClient: PAIR_CLIENT,
    allowedOrigins: [PAGE_ORIGIN],
    invites: true,
    agentTokens: true,
    restartSnapshot: true,
    audit: { dir },
    port: 0,
    logLevel: 'debug',
    logSink: (line) => {
      lines.push(line);
    },
    ...rest,
    timings: { ...FAST_TIMINGS, ...rest.timings },
  });
  const pages: TestPage[] = [];
  const clients: Client[] = [];
  let closed: Promise<void> | null = null;
  const run: Run = {
    relay,
    lines,
    async page(pageOptions = {}) {
      const opened = await connectPage(relay.pageUrl, {
        tools: TOOLS,
        title: 'Board',
        policy: POLICY,
        onInvoke: (frame) => ({ ok: true, content: JSON.stringify({ tool: frame.tool }) }),
        ...pageOptions,
      });
      pages.push(opened);
      return opened;
    },
    async claude(sub, email = null) {
      // Named apart from its subject, so the file's check for subjects means something.
      const client = new Client({ name: 'claude-test', version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(PUBLIC_MCP_URL), {
          authProvider: {
            token: () => idp.token({ sub, aud: PUBLIC_MCP_URL, ...emailClaims(email) }),
          },
          fetch: tunnelFetch(relay.url),
        }),
      );
      clients.push(client);
      return client;
    },
    close() {
      // The relay first, with its pages still connected: a graceful stop.
      closed ??= (async () => {
        await relay.close();
        for (const client of clients.splice(0)) await client.close().catch(() => undefined);
        for (const opened of pages.splice(0)) opened.ws.terminate();
      })();
      return closed;
    },
  };
  runs.push(run);
  return run;
}

/** Every record the audit files hold, oldest first. */
function records(dir: string): AuditLine[] {
  return [...readAuditLines(dir)].map((line) => {
    if (line.record === null) throw new Error(`line ${String(line.lineNumber)} is no record`);
    return line.record;
  });
}

function recordsOf<T extends AuditLine['type']>(
  dir: string,
  type: T,
): Extract<AuditLine, { type: T }>[] {
  return records(dir).filter(
    (record): record is Extract<AuditLine, { type: T }> => record.type === type,
  );
}

/** The records a start wrote: everything after the last relay_start. */
function sinceStart(dir: string): AuditLine[] {
  const all = records(dir);
  const at = all.findLastIndex((record) => record.type === 'relay_start');
  return all.slice(at);
}

function fileOf(dir: string): string {
  return join(dir, SNAPSHOT_FILE);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Whether the text holds a secret or any 10-character run of it; its digest is allowed. */
function holdsRaw(text: string, secret: string): boolean {
  for (let at = 0; at + 10 <= secret.length; at += 1) {
    if (text.includes(secret.slice(at, at + 10))) return true;
  }
  return text.includes(secret);
}

function inviteeId(sub: string): string {
  return `${INVITEE_ID_PREFIX}${inviteeKeyOf(sub)}`;
}

const getView = (page: string) => ({ page, tool: 'get_view', arguments: {} });

/** The page reloading against the restarted relay with the token it last had. */
async function resumeOn(run: Run, page: TestPage, policy: PolicyInput = POLICY): Promise<TestPage> {
  return run.page({ resumeToken: page.welcome?.resumeToken ?? '', policy });
}

function rosterIds(page: TestPage): string[] {
  const roster = page.all('roster').at(-1)?.attachments ?? page.welcome?.roster ?? [];
  return roster.map((attachment) => attachment.userId).sort();
}

/** The warning a start writes when it refuses a snapshot, with its fixed reason. */
function refusalOf(run: Run): string | null {
  for (const line of run.lines) {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.msg === 'restart snapshot not loaded; starting fresh') return String(parsed.reason);
  }
  return null;
}

describe('a graceful restart with TABDOCK_RESTART_SNAPSHOT on (A6.18)', () => {
  it('resumes the page with its attachments, live invite, session and agent token, holding only digests on disk', async () => {
    const idp = await provider();
    const dir = auditDir();
    const first = await startRun(dir, idp);
    const page = await first.page();
    const alice = await first.claude('sub-alice');
    await attachMember(alice, page);
    await attachMember(await first.claude('sub-bob'), page, 'observer');
    const used = await mintOk(page, { role: 'observer', uses: 1 });
    const guest = await first.claude(GUEST, GUEST_EMAIL);
    const joined = await redeem(guest, page, used.link);
    expect(joined.outcome.isError, joined.outcome.text).toBe(false);
    const live = await mintOk(page, { role: 'observer', uses: 1 });
    page.send({
      t: 'session_start',
      sessionId: 'ses_lesson',
      lengthMs: 30 * MINUTE,
      policy: { maxDrivers: 1, proposals: 'off' },
    });
    expect((await latest(page, 'session')).session?.sessionId).toBe('ses_lesson');
    const minted = await mintAgent(page);
    const agent = await connectAgent(first.relay.url, minted.token);
    const asked = await page.next('attach_request');
    page.send({ t: 'attach_decision', requestId: asked.requestId, allow: true });
    await page.sync();
    const agentId = agentUserId(page.pageId, minted.tokenId);
    expect(rosterIds(page)).toEqual(['alice', agentId, 'bob', inviteeId(GUEST)].sort());
    await agent.close();
    const resumeToken = page.welcome?.resumeToken ?? '';
    await first.close();

    // The stop wrote one 0600 file, bound by the log's last two lines.
    const bytes = readFileSync(fileOf(dir));
    expect(statSync(fileOf(dir)).mode & 0o777).toBe(0o600);
    const [written, stopped] = records(dir).slice(-2);
    expect(stopped?.type).toBe('relay_stop');
    expect(written).toMatchObject({
      type: 'snapshot_written',
      pages: 1,
      attachments: 4,
      invites: 1,
      sessions: 1,
      sha256: sha256(bytes),
    });
    // Digests only: never a resume token, an invite secret, the agent's
    // token, the pairing code or a subject, though their digests are there.
    const text = bytes.toString('utf8');
    for (const secret of [resumeToken, used.secret, live.secret, minted.token]) {
      expect(holdsRaw(text, secret)).toBe(false);
    }
    expect(text).not.toContain(page.code);
    expect(text).not.toContain(page.code.replace(/\W/g, ''));
    for (const sub of ['sub-alice', GUEST]) expect(text).not.toContain(sub);
    expect(text).toContain(live.hash);
    expect(text).toContain(minted.hash);
    expect(RelaySnapshotSchema.safeParse(JSON.parse(text)).success).toBe(true);

    const second = await startRun(dir, idp);
    expect(existsSync(fileOf(dir))).toBe(false);
    const [start, loaded] = sinceStart(dir);
    expect(start).toMatchObject({ type: 'relay_start', restartSnapshot: true });
    expect(loaded).toMatchObject({
      type: 'snapshot_loaded',
      pages: 1,
      attachments: 4,
      invites: 1,
      sessions: 1,
      dropped: 0,
    });
    const back = await resumeOn(second, page);
    expect([back.welcome?.resumed, back.pageId]).toEqual([true, page.pageId]);
    expect(rosterIds(back)).toEqual(['alice', agentId, 'bob', inviteeId(GUEST)].sort());
    const session = back.all('session').at(-1)?.session;
    expect(session?.sessionId).toBe('ses_lesson');
    expect(session?.remainingMs).toBeGreaterThan(29 * MINUTE);
    // The session's one driver seat holds again, worked out from the ceiling
    // and the session rather than read from the file (S5).
    back.send({ t: 'set_role', userId: 'bob', role: 'driver' });
    expect(
      (await latest(back, 'roster')).attachments.find((attachment) => attachment.userId === 'bob')
        ?.role,
    ).toBe('observer');
    expect((await latest(back, 'invites')).invites.map((invite) => invite.inviteId)).toEqual([
      live.inviteId,
    ]);
    expect((await latest(back, 'agents')).agents).toMatchObject([
      { tokenId: minted.tokenId, state: 'attached' },
    ]);
    // Each calls through again, the agent with no new prompt.
    const aliceAgain = await second.claude('sub-alice');
    expect((await call(aliceAgain, 'call_page_tool', getView(page.pageId))).isError).toBe(false);
    const guestAgain = await second.claude(GUEST, GUEST_EMAIL);
    expect((await call(guestAgain, 'call_page_tool', getView(page.pageId))).isError).toBe(false);
    const agentAgain = await connectAgent(second.relay.url, minted.token);
    try {
      const result = await agentAgain.callTool({
        name: 'call_page_tool',
        arguments: getView(page.pageId),
      });
      expect(result.isError).not.toBe(true);
    } finally {
      await agentAgain.close();
    }
    expect(back.all('attach_request')).toEqual([]);
    // And the live invite still lets someone in.
    const dave = await second.claude('sub-dave', 'dave@example.com');
    const later = await redeem(dave, back, live.link);
    expect(later.outcome.isError, later.outcome.text).toBe(false);
  });

  it('never brings back a revoked attachment or a closed invite', async () => {
    const idp = await provider();
    const dir = auditDir();
    const first = await startRun(dir, idp);
    const page = await first.page();
    const alice = await first.claude('sub-alice');
    await attachMember(alice, page);
    const bob = await first.claude('sub-bob');
    await attachMember(bob, page, 'observer');
    const cancelled = await mintOk(page, { role: 'observer', uses: 1 });
    page.send({ t: 'invite_cancel', inviteId: cancelled.inviteId });
    page.send({ t: 'revoke', userId: 'bob' });
    await latest(page, 'roster');
    expect(rosterIds(page)).toEqual(['alice']);
    await first.close();
    expect(recordsOf(dir, 'snapshot_written')[0]).toMatchObject({ attachments: 1, invites: 0 });

    const second = await startRun(dir, idp);
    const back = await resumeOn(second, page);
    expect(back.welcome?.resumed).toBe(true);
    expect(rosterIds(back)).toEqual(['alice']);
    expect((await latest(back, 'invites')).invites).toEqual([]);
    const bobAgain = await second.claude('sub-bob');
    const refused = await call(bobAgain, 'call_page_tool', getView(page.pageId));
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('not_attached');
    const carol = await second.claude('sub-carol', 'carol@example.com');
    const closed = await call(carol, 'pair_page', { invite: cancelled.link });
    expect(closed.isError).toBe(true);
    expect(back.all('attach_request')).toEqual([]);
  });

  it('is used at most once: the start removes the file, and a copy put back later is refused', async () => {
    const idp = await provider();
    const dir = auditDir();
    const first = await startRun(dir, idp);
    const page = await first.page();
    await attachMember(await first.claude('sub-alice'), page);
    await first.close();
    const kept = join(privateDir(), 'kept.json');
    copyFileSync(fileOf(dir), kept);

    const second = await startRun(dir, idp);
    expect(existsSync(fileOf(dir))).toBe(false);
    expect(recordsOf(dir, 'snapshot_loaded')).toHaveLength(1);
    const back = await resumeOn(second, page);
    expect(back.welcome?.resumed).toBe(true);
    await second.close();

    // The first stop's file again, over the second stop's own: the log names the second's.
    copyFileSync(kept, fileOf(dir));
    chmodSync(fileOf(dir), 0o600);
    const third = await startRun(dir, idp);
    expect(refusalOf(third)).toBe('the snapshot_written record names another file');
    expect(existsSync(fileOf(dir))).toBe(false);
    expect(recordsOf(dir, 'snapshot_loaded')).toHaveLength(1);
    const fresh = await resumeOn(third, back);
    expect(fresh.welcome?.resumed).toBe(false);
    expect(fresh.pageId).not.toBe(page.pageId);
  });

  it('refuses a snapshot older than the resume window, and removes it', async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    const idp = await provider();
    const dir = auditDir();
    const first = await startRun(dir, idp);
    const page = await first.page();
    await attachMember(await first.claude('sub-alice'), page);
    await first.close();
    vi.setSystemTime(Date.now() + RESUME_WINDOW_MS);
    const second = await startRun(dir, idp);
    expect(refusalOf(second)).toBe('it is older than the resume window');
    expect(existsSync(fileOf(dir))).toBe(false);
    expect(recordsOf(dir, 'snapshot_loaded')).toEqual([]);
    expect((await resumeOn(second, page)).welcome?.resumed).toBe(false);
  });

  it('drops a member the members file no longer lists, and what they sponsored', async () => {
    const idp = await provider();
    const dir = auditDir();
    const members = join(privateDir(), 'members.txt');
    const save = (lines: string[]): void => {
      writeFileSync(`${members}.new`, `${lines.join('\n')}\n`, { mode: 0o600 });
      renameSync(`${members}.new`, members);
    };
    save(['sub-alice=alice:Alice', 'sub-bob=bob:Bob']);
    const first = await startRun(dir, idp, { membersFile: members });
    const page = await first.page();
    // Bob is attached longest, so he sponsors what the page mints.
    await attachMember(await first.claude('sub-bob'), page);
    await attachMember(await first.claude('sub-alice'), page, 'observer');
    const sponsored = await mintOk(page, { role: 'observer', uses: 1 });
    const kept = await mintOk(page, { role: 'observer', uses: 1 });
    expect(sponsored.answer.invites[0]?.sponsor.userId).toBe('bob');
    const joined = await redeem(await first.claude(GUEST, GUEST_EMAIL), page, sponsored.link);
    expect(joined.outcome.isError, joined.outcome.text).toBe(false);
    await first.close();
    expect(recordsOf(dir, 'snapshot_written')[0]).toMatchObject({ attachments: 3, invites: 1 });

    save(['sub-alice=alice:Alice']);
    const second = await startRun(dir, idp, { membersFile: members });
    const loaded = sinceStart(dir);
    expect(loaded.map((record) => record.type)).toEqual([
      'relay_start',
      'expire',
      'invite_closed',
      'expire',
      'sponsor_gone',
      'snapshot_loaded',
    ]);
    expect(loaded).toMatchObject([
      {},
      { userId: 'bob', reason: 'membership_changed' },
      { inviteId: kept.inviteId, reason: 'sponsor_gone' },
      { userId: inviteeId(GUEST), reason: 'sponsor_gone' },
      { sponsor: 'bob', invites: 1, attachments: 1 },
      { pages: 1, attachments: 1, invites: 0, dropped: 2 },
    ]);
    const back = await resumeOn(second, page);
    expect(rosterIds(back)).toEqual(['alice']);
    const bobAgain = await second.claude('sub-bob');
    expect((await call(bobAgain, 'call_page_tool', getView(page.pageId))).isError).toBe(true);
  });

  it('drops a member whose user id the list now gives someone else, and an invitee now a member', async () => {
    const idp = await provider();
    const dir = auditDir();
    const first = await startRun(dir, idp);
    const page = await first.page();
    await attachMember(await first.claude('sub-alice'), page);
    await attachMember(await first.claude('sub-bob'), page, 'observer');
    const invite = await mintOk(page, { role: 'observer', uses: 1 });
    const joined = await redeem(await first.claude(GUEST, GUEST_EMAIL), page, invite.link);
    expect(joined.outcome.isError, joined.outcome.text).toBe(false);
    await first.close();

    const second = await startRun(dir, idp, {
      users: [
        { sub: 'sub-alice', userId: 'alice', displayName: 'Alice' },
        // Bob's id now names another subject, and the guest's subject is a member now.
        { sub: 'sub-carol', userId: 'bob', displayName: 'Bob' },
        { sub: GUEST, userId: 'gina', displayName: 'Gina' },
      ],
    });
    expect(recordsOf(dir, 'snapshot_loaded')[0]).toMatchObject({ attachments: 1, dropped: 2 });
    expect(
      recordsOf(dir, 'expire')
        .filter((record) => record.reason === 'membership_changed')
        .map((record) => record.userId)
        .sort(),
    ).toEqual(['bob', inviteeId(GUEST)].sort());
    const back = await resumeOn(second, page);
    expect(rosterIds(back)).toEqual(['alice']);
    // Carol signs in as bob now, and holds none of the page.
    const carol = await second.claude('sub-carol');
    expect((await call(carol, 'call_page_tool', getView(page.pageId))).isError).toBe(true);
  });

  it('ends a session whose end passed while the relay was down, with reason time', async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    const idp = await provider();
    const dir = auditDir();
    const first = await startRun(dir, idp);
    const page = await first.page({ policy: { invites: 'watch' } });
    await attachMember(await first.claude('sub-alice'), page);
    page.send({
      t: 'session_start',
      sessionId: 'ses_short',
      lengthMs: 30 * MINUTE,
      policy: { maxDrivers: 1, proposals: 'off' },
    });
    await latest(page, 'session');
    const invite = await mintOk(page, { role: 'observer', uses: 1 });
    const joined = await redeem(await first.claude(GUEST, GUEST_EMAIL), page, invite.link);
    expect(joined.outcome.isError, joined.outcome.text).toBe(false);
    await mintOk(page, { role: 'observer', uses: 1 });
    const startedAt = Date.now();
    vi.setSystemTime(startedAt + 29 * MINUTE);
    await first.close();
    expect(recordsOf(dir, 'snapshot_written')[0]).toMatchObject({ sessions: 1, attachments: 2 });

    vi.setSystemTime(startedAt + 31 * MINUTE);
    const second = await startRun(dir, idp);
    const loaded = sinceStart(dir);
    expect(loaded.find((record) => record.type === 'session_end')).toMatchObject({
      sessionId: 'ses_short',
      reason: 'time',
      attachments: 1,
      invites: 1,
    });
    expect(loaded.at(-1)).toMatchObject({
      type: 'snapshot_loaded',
      sessions: 0,
      attachments: 1,
      invites: 0,
    });
    const back = await resumeOn(second, page, { invites: 'watch' });
    expect(back.all('session').at(-1)).toMatchObject({
      session: null,
      ended: { sessionId: 'ses_short', reason: 'time' },
    });
    expect(rosterIds(back)).toEqual(['alice']);
  });

  it('refuses a tampered file, and one the log never named', async () => {
    const idp = await provider();
    const dir = auditDir();
    const first = await startRun(dir, idp);
    const page = await first.page();
    await attachMember(await first.claude('sub-alice'), page);
    await first.close();
    const original = readFileSync(fileOf(dir), 'utf8');
    // One page title changed, the file otherwise as written, its mode kept.
    writeFileSync(fileOf(dir), original.replace('"title":"Board"', '"title":"Bored"'));
    expect(statSync(fileOf(dir)).mode & 0o777).toBe(0o600);
    const second = await startRun(dir, idp);
    expect(refusalOf(second)).toBe('the snapshot_written record names another file');
    expect(existsSync(fileOf(dir))).toBe(false);
    expect((await resumeOn(second, page)).welcome?.resumed).toBe(false);
    await second.close();

    // A relay with the setting off stops with no snapshot_written; a file planted after it never loads.
    const quiet = await startRun(dir, idp, { restartSnapshot: false });
    await quiet.close();
    writeFileSync(fileOf(dir), original, { mode: 0o600 });
    const third = await startRun(dir, idp);
    expect(refusalOf(third)).toBe(
      'the relay_stop that ends the audit log follows no snapshot_written',
    );
    expect(existsSync(fileOf(dir))).toBe(false);
    expect(recordsOf(dir, 'snapshot_loaded')).toEqual([]);
  });

  it('with the setting off, writes nothing, removes a file an earlier run left unread, and ends everything', async () => {
    const idp = await provider();
    const dir = auditDir();
    const on = await startRun(dir, idp);
    const page = await on.page();
    await attachMember(await on.claude('sub-alice'), page);
    await on.close();
    expect(existsSync(fileOf(dir))).toBe(true);

    const off = await startRun(dir, idp, { restartSnapshot: false });
    expect(existsSync(fileOf(dir))).toBe(false);
    expect(sinceStart(dir)[0]).toMatchObject({ type: 'relay_start', restartSnapshot: false });
    expect(
      off.lines.some((line) =>
        line.includes('removed a restart snapshot an earlier run left, unread'),
      ),
    ).toBe(true);
    const fresh = await resumeOn(off, page);
    expect(fresh.welcome?.resumed).toBe(false);
    await attachMember(await off.claude('sub-alice'), fresh);
    await off.close();
    expect(existsSync(fileOf(dir))).toBe(false);
    expect(records(dir).at(-1)?.type).toBe('relay_stop');
    expect(recordsOf(dir, 'snapshot_written')).toHaveLength(1);

    const again = await startRun(dir, idp, { restartSnapshot: false });
    expect((await resumeOn(again, fresh)).welcome?.resumed).toBe(false);
  });

  it('refuses a snapshot this relay could not have taken, with invites now off', async () => {
    const idp = await provider();
    const dir = auditDir();
    const first = await startRun(dir, idp);
    const page = await first.page();
    await attachMember(await first.claude('sub-alice'), page);
    const invite = await mintOk(page, { role: 'observer', uses: 1 });
    const joined = await redeem(await first.claude(GUEST, GUEST_EMAIL), page, invite.link);
    expect(joined.outcome.isError, joined.outcome.text).toBe(false);
    await first.close();
    const second = await startRun(dir, idp, { invites: false, agentTokens: false });
    expect(refusalOf(second)).toBe('invited accounts, and invites are off');
    expect(existsSync(fileOf(dir))).toBe(false);
    expect(recordsOf(dir, 'snapshot_loaded')).toEqual([]);
    expect((await resumeOn(second, page)).welcome?.resumed).toBe(false);
  });
});

/**
 * One graceful stop's audit directory, copied for each case below so each
 * takes its own copy of a bound snapshot: the binding itself is the log's.
 */
async function boundDirectory(): Promise<{ source: string; snapshot: RelaySnapshot }> {
  const idp = await provider();
  const source = auditDir();
  const run = await startRun(source, idp);
  const page = await run.page();
  await attachMember(await run.claude('sub-alice'), page);
  await run.close();
  const snapshot = RelaySnapshotSchema.parse(JSON.parse(readFileSync(fileOf(source), 'utf8')));
  return { source, snapshot };
}

function copyOf(source: string): string {
  const dir = join(privateDir(), 'audit');
  cpSync(source, dir, { recursive: true });
  // The lock a closed relay released is gone already; nothing else in the copy is the relay's.
  return dir;
}

describe('taking the file (snapshot.ts)', () => {
  it('loads a bound, fresh copy, and only in the mode that wrote it', async () => {
    const { source, snapshot } = await boundDirectory();
    const at = snapshot.writtenAt;
    const take = (now: number, mode: 'public' | 'dev_tokens' = 'public') =>
      takeSnapshot({ dir: copyOf(source), enabled: true, now, mode });
    expect(take(at + RESUME_WINDOW_MS - 1)).toMatchObject({
      kind: 'loaded',
      ageMs: RESUME_WINDOW_MS - 1,
    });
    expect(take(at + RESUME_WINDOW_MS)).toEqual({
      kind: 'refused',
      reason: 'it is older than the resume window',
      removed: true,
    });
    expect(take(at - 1)).toEqual({
      kind: 'refused',
      reason: 'it was written in the future',
      removed: true,
    });
    expect(take(at, 'dev_tokens')).toEqual({
      kind: 'refused',
      reason: 'it was written in another mode',
      removed: true,
    });
  });

  it('loads nothing when the file cannot be removed first', async () => {
    const { source, snapshot } = await boundDirectory();
    const dir = copyOf(source);
    const fs: SnapshotFs = {
      ...nodeFs,
      unlinkSync: () => {
        throw Object.assign(new Error('read-only'), { code: 'EROFS' });
      },
    };
    expect(
      takeSnapshot({ dir, enabled: true, now: snapshot.writtenAt, mode: 'public', fs }),
    ).toEqual({
      kind: 'refused',
      reason: 'it could not be removed (EROFS)',
      removed: false,
    });
  });

  it('refuses a file reached through a link, or with another link, or open to other accounts, and removes the name', async () => {
    const { source, snapshot } = await boundDirectory();
    const take = (dir: string) =>
      takeSnapshot({ dir, enabled: true, now: snapshot.writtenAt, mode: 'public' });

    const linked = copyOf(source);
    const target = join(privateDir(), 'elsewhere.json');
    renameSync(fileOf(linked), target);
    symlinkSync(target, fileOf(linked));
    expect(take(linked)).toEqual({
      kind: 'refused',
      reason: 'cannot open it (ELOOP)',
      removed: true,
    });
    expect(() => lstatSync(fileOf(linked))).toThrow();
    expect(existsSync(target)).toBe(true);

    const hard = copyOf(source);
    const second = join(hard, 'second-name.json');
    linkSync(fileOf(hard), second);
    expect(take(hard)).toEqual({ kind: 'refused', reason: 'it has another link', removed: true });
    expect(existsSync(fileOf(hard))).toBe(false);
    expect(existsSync(second)).toBe(true);

    const open = copyOf(source);
    chmodSync(fileOf(open), 0o644);
    expect(take(open)).toEqual({
      kind: 'refused',
      reason: 'readable or writable by other accounts',
      removed: true,
    });
    expect(existsSync(fileOf(open))).toBe(false);
  });

  it('binds only a snapshot_written that the last relay_stop is chained to, across a rotation too', () => {
    const dir = privateDir();
    const digest = 'a'.repeat(64);
    const writtenText = JSON.stringify({
      v: AUDIT_VERSION,
      seq: 41,
      type: 'snapshot_written',
      at: 1_700_000_000_000,
      pages: 1,
      attachments: 1,
      invites: 0,
      sessions: 0,
      sha256: digest,
      prev: 'b'.repeat(64),
    });
    const stop = (prev: string, seq = 42) =>
      JSON.stringify({ v: AUDIT_VERSION, seq, type: 'relay_stop', at: 1_700_000_000_001, prev });
    // The stop in a file of its own, as a rotation between the two would leave it.
    writeFileSync(join(dir, 'audit-2026-10-10-000000000001.jsonl'), `${writtenText}\n`);
    writeFileSync(
      join(dir, 'audit-2026-10-11-000000000042.jsonl'),
      `${stop(lineHash(writtenText))}\n`,
    );
    expect(bindingProblem(dir, digest)).toBeNull();
    expect(bindingProblem(dir, 'c'.repeat(64))).toBe(
      'the snapshot_written record names another file',
    );
    writeFileSync(join(dir, 'audit-2026-10-11-000000000042.jsonl'), `${stop('d'.repeat(64))}\n`);
    expect(bindingProblem(dir, digest)).toBe("the audit log's last two records are not chained");
    writeFileSync(
      join(dir, 'audit-2026-10-11-000000000042.jsonl'),
      `${stop(lineHash(writtenText), 43)}\n`,
    );
    expect(bindingProblem(dir, digest)).toBe("the audit log's last two records are not chained");
    // Anything after the stop, a torn line included, ends the binding.
    writeFileSync(
      join(dir, 'audit-2026-10-11-000000000042.jsonl'),
      `${stop(lineHash(writtenText))}\n{"v":1,"seq":43,"ty`,
    );
    expect(bindingProblem(dir, digest)).toBe("the audit log's last records cannot be read");
  });

  it('writes a snapshot the schema refuses nowhere, leaving no temporary file', () => {
    const dir = privateDir();
    const empty: RelaySnapshot = {
      v: SNAPSHOT_VERSION,
      writtenAt: 1,
      mode: 'public',
      pages: [],
      attachments: [],
      invites: [],
      agents: [],
    };
    // A field no snapshot lists, as a store that grew a secret would hand one over.
    const broken = { ...empty, pairingCode: 'ABCD-1234' } as RelaySnapshot;
    expect(writeSnapshot(dir, broken)).toEqual({
      kind: 'refused',
      reason: 'the store failed the snapshot schema',
    });
    expect(nodeFs.readdirSync(dir)).toEqual([]);
    const failing: SnapshotFs = {
      ...nodeFs,
      renameSync: () => {
        throw Object.assign(new Error('no'), { code: 'EXDEV' });
      },
    };
    expect(writeSnapshot(dir, empty, failing)).toEqual({
      kind: 'refused',
      reason: 'cannot put its file in place (EXDEV)',
    });
    expect(nodeFs.readdirSync(dir)).toEqual([]);
    expect(writeSnapshot(dir, empty)).toMatchObject({ kind: 'written' });
    expect(nodeFs.readdirSync(dir)).toEqual([SNAPSHOT_FILE]);
    expect(statSync(join(dir, SNAPSHOT_FILE)).mode & 0o777).toBe(0o600);
  });
});

describe('the hub around a snapshot (hub.ts)', () => {
  function hubOf(store = createMemoryStore()): PageHub {
    const config = resolveConfig({ auth: createDevTokenAuth([DEV_ALICE]) });
    return new PageHub(config, store, createLogger({ sink: () => undefined }));
  }

  it('puts a page back asleep, its policy worked out from its ceiling and session, never read', async () => {
    const store = createMemoryStore();
    const hub = hubOf(store);
    const now = Date.now();
    const snapshot: RelaySnapshot = {
      v: SNAPSHOT_VERSION,
      writtenAt: now,
      mode: 'dev_tokens',
      pages: [
        {
          pageId: 'pg_restored',
          origin: PAGE_ORIGIN,
          title: 'Board',
          url: `${PAGE_ORIGIN}/`,
          adapterVersion: 'test',
          connectedAt: now - MINUTE,
          ceiling: PolicySchema.parse({ maxDrivers: 2, proposals: 'members' }),
          timedSession: {
            sessionId: 'ses_1',
            startedAt: now,
            endsAt: now + 30 * MINUTE,
            lengthMs: 30 * MINUTE,
            policy: { maxDrivers: 1, proposals: 'off' },
          },
          sessionEnded: null,
          resumeTokenHash: 'a'.repeat(64),
        },
      ],
      attachments: [],
      invites: [],
      agents: [],
    };
    hub.restoreSnapshot(snapshot, { ageMs: 0, accounts: snapshotAccounts(null) });
    expect(store.pages.get('pg_restored')).toMatchObject({
      state: 'asleep',
      policy: { maxDrivers: 1, proposals: 'off' },
      ceiling: { maxDrivers: 2, proposals: 'members' },
      tools: [],
    });
    expect(store.pages.findByResumeTokenHash('a'.repeat(64))?.pageId).toBe('pg_restored');
    await hub.shutdown();
  });

  it('takes one only once it has stopped taking work, and then refuses a detach', async () => {
    const hub = hubOf();
    const accounts = snapshotAccounts(null);
    expect(() => hub.exportSnapshot(Date.now(), accounts.memberKey)).toThrow(
      /only once the hub has stopped taking work/,
    );
    await hub.shutdown();
    expect(hub.exportSnapshot(5, accounts.memberKey)).toMatchObject({
      v: 1,
      writtenAt: 5,
      pages: [],
    });
    expect(hub.detachPage('alice', 'pg_any')).toEqual({
      kind: 'error',
      code: 'page_asleep',
      message: 'the relay is shutting down',
    });
  });

  it('puts one back only into a hub that holds nothing', async () => {
    const hub = hubOf();
    const empty: RelaySnapshot = {
      v: SNAPSHOT_VERSION,
      writtenAt: 1,
      mode: 'dev_tokens',
      pages: [],
      attachments: [],
      invites: [],
      agents: [],
    };
    expect(
      hub.restoreSnapshot(empty, { ageMs: 0, accounts: snapshotAccounts(null) }),
    ).toMatchObject({
      type: 'snapshot_loaded',
      pages: 0,
      dropped: 0,
    });
    await hub.shutdown();
    expect(() =>
      hub.restoreSnapshot(empty, { ageMs: 0, accounts: snapshotAccounts(null) }),
    ).toThrow(/only into a new hub/);
  });
});

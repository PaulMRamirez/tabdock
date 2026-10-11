// Where the session record (ADR 0045) meets the restart snapshot (ADR 0046),
// end to end and in process: a public relay that keeps an audit directory,
// the sim page running the real adapter core and its recorder, and SDK
// clients signed in through the stand-in provider, which outlives each
// relay. A member, and a guest an invite minted in a time-boxed session let in, call
// the page, and the relay stops gracefully and starts again on the same port
// and audit directory. With the snapshot on, the page resumes its page
// session, so the session's record goes on as one: the same span, the same
// page id, both attachments open from when they joined, the calls from
// either side of the restart, and `audit --match` holding it to a log that
// runs through the stop and the start. An End the operator gives while the
// relay is down ends the session as a live link would, the member staying on
// into the page record, since the relay resumes the page session. With the
// snapshot off the restart is noted instead: the page pairs as a new page
// session, which ended everyone in the lesson's record when the link went.

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  type AuditLine,
  encodeSessionRecord,
  type SessionRecord,
  SessionRecordSchema,
} from '@tabdock/protocol';
import {
  createOAuthAuth,
  createRelay,
  EMAIL_CLAIM,
  EMAIL_VERIFIED_CLAIM,
  readAuditLines,
  type Relay,
} from '@tabdock/relay';
import { PAIR_CLIENT, startProvider, type TestProvider } from '@tabdock/relay/test/provider';
import { PUBLIC_MCP_URL, PUBLIC_ORIGIN, tunnelFetch } from '@tabdock/relay/test/tunnel';
import { DEFAULT_SIM_ORIGIN, type SimPage, startSimPage } from '@tabdock/sim-page';
import { afterEach, describe, expect, it } from 'vitest';
import { runAuditCli } from '../../../packages/relay/src/audit-cli.ts';
import { auditedCallIds } from '../src/record-helpers.ts';
import { callTool } from './helpers.ts';

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
});

const GUEST_EMAIL = 'guest@example.com';

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tabdock-record-restart-')));
  closers.push(() => {
    rmSync(dir, { recursive: true, force: true });
    return Promise.resolve();
  });
  return dir;
}

/** The reader on a record file, as `pnpm audit:log --match <file> --verify --dir <dir>`. */
function match(record: SessionRecord, dir: string): { code: number; lines: string[] } {
  const file = join(scratch(), 'record.json');
  writeFileSync(file, encodeSessionRecord(record));
  const lines: string[] = [];
  const code = runAuditCli(
    ['--match', file, '--verify', '--dir', dir],
    {},
    { out: (line) => lines.push(line), err: (line) => lines.push(line) },
  );
  return { code, lines };
}

function auditTypes(dir: string): AuditLine['type'][] {
  return [...readAuditLines(dir)].flatMap((line) => (line.record ? [line.record.type] : []));
}

interface Bench {
  auditDir: string;
  sim: SimPage;
  pageId: string;
  /** The session's id and the guest's short id, as the record names them. */
  sessionId: string;
  /** Alice, and the guest unless told not to, each call echo once on the relay running now. */
  calls(guest?: boolean): Promise<void>;
  /** A graceful stop, then a start on the same port and audit directory. */
  restart(snapshot: boolean, whileDown?: () => void): Promise<void>;
}

/**
 * A relay with invites and the setting as asked, a page Alice drives, and a
 * 30 minute lesson whose watch link let a guest in, each of them having
 * called once.
 */
async function lesson(snapshot: boolean): Promise<Bench> {
  const provider: TestProvider = await startProvider();
  closers.push(() => provider.stop());
  const auditDir = join(scratch(), 'audit');
  const start = async (on: boolean, port = 0): Promise<Relay> => {
    const relay = await createRelay({
      auth: createOAuthAuth({
        issuer: provider.issuer,
        resource: PUBLIC_MCP_URL,
        users: [{ sub: 'sub-alice', userId: 'alice', displayName: 'Alice' }],
      }),
      publicUrl: PUBLIC_ORIGIN,
      pairClient: PAIR_CLIENT,
      allowedOrigins: [DEFAULT_SIM_ORIGIN],
      invites: true,
      restartSnapshot: on,
      audit: { dir: auditDir },
      port,
      logSink: () => undefined,
    });
    closers.push(() => relay.close());
    return relay;
  };
  let relay = await start(snapshot);
  const client = async (sub: string, email?: string): Promise<Client> => {
    const signedIn = new Client({
      name: sub === 'sub-alice' ? 'claude-code' : 'guest-client',
      version: '1.0.0',
    });
    await signedIn.connect(
      new StreamableHTTPClientTransport(new URL(PUBLIC_MCP_URL), {
        fetch: tunnelFetch(relay.url),
        authProvider: {
          token: () =>
            provider.token({
              sub,
              aud: PUBLIC_MCP_URL,
              ...(email === undefined
                ? {}
                : { [EMAIL_CLAIM]: email, [EMAIL_VERIFIED_CLAIM]: true }),
            }),
        },
      }),
    );
    closers.push(() => signedIn.close());
    return signedIn;
  };

  const sim = await startSimPage({
    relayUrl: relay.pageUrl,
    policy: { invites: 'all', maxDrivers: 2 },
  });
  closers.push(() => sim.close());
  await sim.waitFor((state) => state.link === 'linked' && state.pairing !== null);
  const alice = await client('sub-alice');
  const code = sim.state.pairing?.code ?? '';
  const pairing = callTool(alice, 'pair_page', { code });
  const asked = await sim.waitFor((state) => state.pendingRequests.length > 0);
  expect(sim.dock.approve(asked.pendingRequests[0]?.requestId ?? '', 'driver')).toBe(true);
  const paired = await pairing;
  expect(paired.isError, paired.text).toBe(false);
  const pageId = (paired.structured as { page: string }).page;

  const started = await sim.dock.startSession({ label: 'Lesson', lengthMinutes: 30 });
  if (!started.ok) throw new Error(`no session: ${started.reason}`);
  // An invite minted in the lesson, which its end closes with what it let in (ADR 0043).
  const minted = await sim.invite({ label: 'Watchers', role: 'observer', uses: 1 });
  if (!minted.ok) throw new Error(`no invite: ${minted.reason}`);
  const guest = await client('sub-guest', GUEST_EMAIL);
  const joined = await callTool(guest, 'pair_page', { invite: minted.link });
  expect(joined.isError, joined.text).toBe(false);
  await sim.waitFor((state) => state.roster.length === 2);

  const bench: Bench = {
    auditDir,
    sim,
    pageId,
    sessionId: started.sessionId,
    async calls(guest = true) {
      // Signed in afresh on whichever relay runs now: a restart keeps no MCP session.
      const callers = [await client('sub-alice')];
      if (guest) callers.push(await client('sub-guest', GUEST_EMAIL));
      for (const who of callers) {
        const done = await callTool(who, 'call_page_tool', {
          page: pageId,
          tool: 'echo',
          arguments: { note: 'MARKER-ARGUMENT' },
        });
        expect(done.isError, done.text).toBe(false);
      }
    },
    async restart(on, whileDown) {
      const port = Number(new URL(relay.url).port);
      await relay.close();
      await sim.waitFor((state) => state.link !== 'linked');
      whileDown?.();
      relay = await start(on, port);
      await sim.waitFor(
        (state) => state.link === 'linked' && state.pageId !== null && state.pairing !== null,
        20_000,
      );
    },
  };
  await bench.calls();
  return bench;
}

/** The record the page keeps in `which`, checked as the save checks it. */
function recordOf(
  sim: SimPage,
  which: 'current' | 'previous' | 'ended' = 'current',
): SessionRecord {
  const record = sim.sessionRecord(which);
  if (record === null) throw new Error(`no ${which} record`);
  expect(SessionRecordSchema.parse(record)).toEqual(record);
  return record;
}

const spans = (record: SessionRecord): unknown[] =>
  record.attachments.map((span) => [
    span.user.kind,
    span.how,
    span.before,
    span.joinedAt,
    span.ended,
  ]);

describe('a session record across a relay restart (ADR 0045 with ADR 0046)', () => {
  it('goes on as one record when the snapshot resumes the page session, and passes audit --match through the stop and the start', async () => {
    const bench = await lesson(true);
    const { auditDir, sim, pageId, sessionId } = bench;
    const before = recordOf(sim);
    expect(before.scope).toMatchObject({ kind: 'session', sessionId, endedAt: null });
    expect(before.calls).toHaveLength(2);
    const joined = spans(before);
    expect(joined).toEqual([
      ['member', 'approved', true, before.from, null],
      ['invitee', 'invite', false, expect.any(Number) as unknown, null],
    ]);

    await bench.restart(true);
    expect(sim.state.pageId).toBe(pageId);
    expect(sim.state.session?.sessionId).toBe(sessionId);
    await bench.calls();

    // One record: its span, page and attachments as before, the calls from both sides.
    const after = recordOf(sim);
    expect(after.from).toBe(before.from);
    expect(after.scope).toEqual(before.scope);
    expect(after.pageIds).toEqual([pageId]);
    expect(spans(after)).toEqual(joined);
    expect(after.calls.map((call) => call.callId)).toEqual(auditedCallIds(auditDir));
    expect(after.calls.slice(0, 2)).toEqual(before.calls);
    // The log runs through the stop and the start, bound by the snapshot.
    const types = auditTypes(auditDir);
    const stop = types.indexOf('snapshot_written');
    expect(types.slice(stop, stop + 4)).toEqual([
      'snapshot_written',
      'relay_stop',
      'relay_start',
      'snapshot_loaded',
    ]);
    const kept = match(after, auditDir);
    expect(kept.code, kept.lines.join('\n')).toBe(0);
    expect(kept.lines.at(-1)).toMatch(/^match: agrees with the log; 4 calls matched, 0 missing/);
    expect(kept.lines.some((line) => line.startsWith('verify: chain intact'))).toBe(true);
    expect(encodeSessionRecord(after)).not.toContain('MARKER-ARGUMENT');

    // Its end seals the same record, the guest leaving with the session and Alice staying on.
    expect(sim.dock.endSession()).toBe(true);
    await sim.waitFor((state) => state.roster.length === 1);
    const ended = recordOf(sim, 'ended');
    expect(ended.from).toBe(before.from);
    expect(ended.attachments.map((span) => [span.user.kind, span.ended])).toEqual([
      ['member', null],
      ['invitee', 'session_ended'],
    ]);
    const sealed = match(ended, auditDir);
    expect(sealed.code, sealed.lines.join('\n')).toBe(0);
  }, 60_000);

  it('ends the lesson as a live link would when End comes while the relay is down and the snapshot resumes the page', async () => {
    const bench = await lesson(true);
    const { auditDir, sim, pageId } = bench;
    const before = recordOf(sim);
    let downAt = 0;
    await bench.restart(true, () => {
      downAt = Date.now();
      expect(sim.dock.endSession()).toBe(true);
    });
    expect(sim.state.pageId).toBe(pageId);
    // The page tells the relay, which lists the lesson again, and its guest leaves.
    await sim.waitFor((state) => state.roster.length === 1, 10_000);

    const ended = recordOf(sim, 'ended');
    expect(ended.from).toBe(before.from);
    if (ended.scope.kind !== 'session') throw new Error('not the lesson');
    expect(ended.scope.endedBy).toBe('operator');
    const endedAt = ended.scope.endedAt ?? 0;
    expect(endedAt).toBeGreaterThanOrEqual(downAt);
    // Alice was never detached: the page session went on through the restart.
    // The guest left with the lesson when End came, after the link went.
    expect(ended.attachments.map((span) => [span.user.kind, span.leftAt, span.ended])).toEqual([
      ['member', null, null],
      ['invitee', endedAt, 'session_ended'],
    ]);
    const page = recordOf(sim);
    expect(page.scope.kind).toBe('page');
    expect(page.pageIds).toEqual([pageId]);
    // Alice stays on from its start. The resumed relay lists the guest until
    // it hears of the end, with no grant here, so the page record holds that
    // listing as it was: unapproved, from the welcome, until the relay let go.
    expect(spans(page)).toEqual([
      ['member', 'approved', true, page.from, null],
      ['invitee', 'unapproved', false, expect.any(Number) as unknown, 'left'],
    ]);
    expect(page.attachments[1]?.joinedAt).toBeGreaterThanOrEqual(ended.to);
    await bench.calls(false);
    expect(recordOf(sim).calls.map((call) => call.user.id)).toEqual(['alice']);
    for (const record of [ended, recordOf(sim)]) {
      const held = match(record, auditDir);
      expect(held.code, held.lines.join('\n')).toBe(0);
    }
  }, 60_000);

  it('notes the restart when the snapshot is off: a new page session ended everyone in the lesson when the link went', async () => {
    const bench = await lesson(false);
    const { auditDir, sim, pageId } = bench;
    const before = recordOf(sim);
    const lostBy = Date.now();
    await bench.restart(false);
    expect(sim.state.pageId).not.toBe(pageId);

    const ended = recordOf(sim, 'ended');
    expect(ended.from).toBe(before.from);
    expect(ended.pageIds).toEqual([pageId]);
    expect(ended.scope).toMatchObject({ endedBy: 'relay' });
    expect(ended.calls).toEqual(before.calls);
    for (const span of ended.attachments) {
      expect(span.ended).toBe('page_session_ended');
      expect(span.leftAt).toBeGreaterThanOrEqual(lostBy);
      expect(span.leftAt).toBeLessThanOrEqual(ended.to);
    }
    expect(ended.attachments).toHaveLength(2);
    // The page record before the lesson is still the one kept, and the new one carries no one.
    expect(recordOf(sim, 'previous').to).toBe(before.from);
    expect(recordOf(sim)).toMatchObject({ pageIds: [sim.state.pageId], attachments: [] });
    const held = match(ended, auditDir);
    expect(held.code, held.lines.join('\n')).toBe(0);
    expect(auditTypes(auditDir)).not.toContain('snapshot_written');
  }, 60_000);
});

// A6.25 end to end, in process: a public relay that keeps an audit
// directory, the sim page running the real adapter core, and SDK clients
// signed in through the stand-in provider. Two members and an invitee
// attach, Alice confirms a consequential call in her own client, the
// operator allows Bob's on the page, Bob is revoked, and the record the
// handle gives names each by the id the widget shows, invitees by short id,
// holds every call by its callId and nothing any call carried, and passes
// `tabdock-relay audit --match --verify` against the relay's own log, which
// a call added or taken out of the file fails.

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Client,
  type ElicitRequestFormParams,
  type ElicitResult,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { encodeSessionRecord, type SessionRecord, SessionRecordSchema } from '@tabdock/protocol';
import { createOAuthAuth, createRelay, EMAIL_CLAIM, EMAIL_VERIFIED_CLAIM } from '@tabdock/relay';
import { PAIR_CLIENT, startProvider, type TestProvider } from '@tabdock/relay/test/provider';
import { PUBLIC_MCP_URL, PUBLIC_ORIGIN, tunnelFetch } from '@tabdock/relay/test/tunnel';
import { DEFAULT_SIM_ORIGIN, type SimPage, startSimPage } from '@tabdock/sim-page';
import { afterEach, describe, expect, it } from 'vitest';
import { runAuditCli } from '../../../packages/relay/src/audit-cli.ts';
import { sessionRecordMarkdown } from '../../../packages/adapter/src/record-markdown.ts';
import { auditedCallIds } from '../src/record-helpers.ts';
import { callTool } from './helpers.ts';

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
});

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tabdock-session-record-')));
  closers.push(() => {
    rmSync(dir, { recursive: true, force: true });
    return Promise.resolve();
  });
  return dir;
}

/** The reader on a record file, as `pnpm audit:log --match <file> --verify --dir <dir>`. */
function match(record: SessionRecord, dir: string): { code: number; out: string[]; err: string[] } {
  const file = join(scratch(), 'record.json');
  writeFileSync(file, encodeSessionRecord(record));
  const out: string[] = [];
  const err: string[] = [];
  const code = runAuditCli(
    ['--match', file, '--verify', '--dir', dir],
    {},
    { out: (line) => out.push(line), err: (line) => err.push(line) },
  );
  return { code, out, err };
}

interface Bench {
  provider: TestProvider;
  auditDir: string;
  sim: SimPage;
  /** An SDK client signed in as `sub`, answering a form elicitation with `answer` when given one. */
  client: (sub: string, name: string, email?: string, answer?: ElicitResult) => Promise<Client>;
}

async function bench(): Promise<Bench> {
  const provider = await startProvider();
  closers.push(() => provider.stop());
  const auditDir = join(scratch(), 'audit');
  const relay = await createRelay({
    auth: createOAuthAuth({
      issuer: provider.issuer,
      resource: PUBLIC_MCP_URL,
      users: [
        { sub: 'sub-alice', userId: 'alice', displayName: 'Alice' },
        { sub: 'sub-bob', userId: 'bob', displayName: 'Bob' },
      ],
    }),
    publicUrl: PUBLIC_ORIGIN,
    pairClient: PAIR_CLIENT,
    allowedOrigins: [DEFAULT_SIM_ORIGIN],
    invites: true,
    audit: { dir: auditDir },
    port: 0,
    logSink: () => undefined,
  });
  closers.push(() => relay.close());
  const tunnel = tunnelFetch(relay.url);
  const sim = await startSimPage({
    relayUrl: relay.pageUrl,
    policy: { consequential: 'confirm', confirmVia: 'client', invites: 'all', maxDrivers: 2 },
  });
  closers.push(() => sim.close());
  await sim.waitFor((state) => state.link === 'linked' && state.pairing !== null);
  return {
    provider,
    auditDir,
    sim,
    client: async (sub, name, email, answer) => {
      const client = new Client(
        { name, version: '1.0.0' },
        { capabilities: answer === undefined ? {} : { elicitation: { form: {} } } },
      );
      if (answer !== undefined) {
        client.setRequestHandler('elicitation/create', (request) => {
          expect((request.params as ElicitRequestFormParams).mode ?? 'form').toBe('form');
          return answer;
        });
      }
      await client.connect(
        new StreamableHTTPClientTransport(new URL(PUBLIC_MCP_URL), {
          fetch: tunnel,
          authProvider: {
            token: () =>
              provider.token({
                sub,
                aud: PUBLIC_MCP_URL,
                client_id: 'https://claude.ai/oauth/mcp-client',
                ...(email === undefined
                  ? {}
                  : { [EMAIL_CLAIM]: email, [EMAIL_VERIFIED_CLAIM]: true }),
              }),
          },
        }),
      );
      closers.push(() => client.close());
      return client;
    },
  };
}

/** pair_page by the page's code, approved as `role` by the operator through the page's handle. */
async function pair(sim: SimPage, client: Client, role: 'driver' | 'observer'): Promise<string> {
  const code = sim.state.pairing?.code ?? '';
  const pending = callTool(client, 'pair_page', { code });
  const state = await sim.waitFor((s) => s.pendingRequests.length > 0);
  const request = state.pendingRequests[0];
  if (request === undefined) throw new Error('no attach request');
  expect(sim.dock.approve(request.requestId, role)).toBe(true);
  const outcome = await pending;
  expect(outcome.isError, outcome.text).toBe(false);
  await sim.waitFor((s) => s.pairing !== null && s.pairing.code !== code);
  return (outcome.structured as { page: string }).page;
}

describe('a session record saved from a real run (A6.25)', () => {
  it('names everyone as the widget does, holds every call by its callId, and passes audit --match', async () => {
    const { auditDir, sim, client } = await bench();
    const accept: ElicitResult = { action: 'accept', content: { confirm: true } };
    const alice = await client('sub-alice', 'claude-code', undefined, accept);
    const bob = await client('sub-bob', 'bob-client');
    const guest = await client('sub-guest', 'guest-client', 'guest@example.com');
    const pageId = await pair(sim, alice, 'driver');
    await pair(sim, bob, 'driver');
    const minted = await sim.invite({ label: 'Watchers', role: 'observer', uses: 1 });
    if (!minted.ok) throw new Error(`no invite: ${minted.reason}`);
    const joined = await callTool(guest, 'pair_page', { invite: minted.link });
    expect(joined.isError, joined.text).toBe(false);
    await sim.waitFor((state) => state.roster.length === 3);
    const call = (who: Client, tool: string, args: Record<string, unknown> = {}) =>
      callTool(who, 'call_page_tool', { page: pageId, tool, arguments: args });

    // Alice confirms in her own client; the page runs it without asking (ADR 0026).
    const confirmedThere = await call(alice, 'wipe');
    expect(confirmedThere.isError, confirmedThere.text).toBe(false);
    // Bob's client cannot confirm, so the operator allows his on the page.
    const asked = call(bob, 'wipe');
    const prompt = (await sim.waitFor((state) => state.pendingConfirms.length > 0))
      .pendingConfirms[0];
    if (prompt === undefined) throw new Error('no prompt');
    expect(sim.dock.confirm(prompt.callId, true)).toBe(true);
    expect((await asked).isError).toBe(false);
    const read = await call(guest, 'echo', { note: 'MARKER-ARGUMENT' });
    expect(read.text).toContain('MARKER-ARGUMENT');
    expect(sim.dock.revoke('bob')).toBe(true);
    await sim.waitFor((state) => state.roster.length === 2);

    const record = sim.sessionRecord();
    if (record === null) throw new Error('no record');
    expect(SessionRecordSchema.parse(record)).toEqual(record);
    expect(record.calls.map((each) => [each.user.id, each.tool, each.confirmedBy])).toEqual([
      ['alice', 'wipe', 'client'],
      ['bob', 'wipe', 'page'],
      [expect.stringMatching(/^g_[0-9a-f]{8}$/), 'echo', null],
    ]);
    expect(
      record.attachments.map((span) => [span.user.kind, span.how, span.ended, span.inviteId]),
    ).toEqual([
      ['member', 'approved', null, null],
      ['member', 'approved', 'revoked', null],
      ['invitee', 'invite', null, minted.inviteId],
    ]);
    expect(record.attachments[2]?.user.name).toBe('guest@example.com');
    // Every call's callId is a call line the relay wrote, and every one it wrote is here.
    expect(auditedCallIds(auditDir)).toEqual(record.calls.map((each) => each.callId));
    for (const text of [encodeSessionRecord(record), sessionRecordMarkdown(record)]) {
      expect(text).not.toContain('MARKER-ARGUMENT');
      expect(text).not.toContain(minted.link.slice(minted.link.indexOf('#') + 1));
      for (const attached of sim.state.roster) {
        if (attached.kind === 'invitee') expect(text).not.toContain(attached.userId);
      }
    }

    const genuine = match(record, auditDir);
    expect(genuine.code, [...genuine.out, ...genuine.err].join('\n')).toBe(0);
    expect(genuine.err.at(-1)).toMatch(/^match: agrees with the log; 3 calls matched, 0 missing/);
    expect(genuine.err.some((line) => line.startsWith('verify: chain intact'))).toBe(true);

    const [first, second] = record.calls;
    if (first === undefined || second === undefined) throw new Error('no calls');
    const added = match(
      { ...record, calls: [...record.calls, { ...first, callId: 'cl_made_up' }] },
      auditDir,
    );
    expect(added.code).toBe(1);
    expect(added.out).toEqual([expect.stringMatching(/^FAIL missing: call cl_made_up /)]);
    const removed = match(
      { ...record, calls: record.calls.filter((each) => each !== second) },
      auditDir,
    );
    expect(removed.code).toBe(1);
    expect(removed.out).toEqual([
      expect.stringMatching(new RegExp(`^FAIL unrecorded: call ${second.callId} `)),
    ]);
    const changed = match(
      { ...record, calls: [first, { ...second, tool: 'set_value' }, ...record.calls.slice(2)] },
      auditDir,
    );
    expect(changed.code).toBe(1);
  }, 60_000);
});

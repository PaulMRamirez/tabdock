// The persistent audit log inside a running relay (S7, S11, ADR 0019):
// production refuses to start without its directory or when relay_start does
// not reach the disk; relay_start and relay_stop bracket every run; a call the
// shutdown fails is on disk before the log closes; local mode keeps its log in
// audit/ beside the owner token; a second relay on the same directory, in
// this process or another, refuses to start before it writes a line, so the
// chain stays whole; and no file line or log line holds a token, a pairing
// code, a resume token, an argument or a client address. Then the reader,
// pnpm audit:log, over what the relay wrote, each filter shown to leave
// something out.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { AuditLineSchema } from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { escapeForTerminal, runAuditCli } from '../src/audit-cli.ts';
import {
  createDevTokenAuth,
  createMemoryStore,
  createRelay,
  lineHash,
  listAuditFiles,
  loadConfigFromEnv,
  readAuditLines,
  utcDay,
  verifyAuditLines,
} from '../src/index.ts';
import { startMain } from './helpers/main-process.ts';
import { connectPage, PAGE_ORIGIN, type TestPage, TOOLS } from './helpers/page-client.ts';
import {
  ALICE,
  BOB,
  callTool,
  connectClient,
  pairAndApprove,
  startRelay,
  type TestRelay,
} from './helpers/relay.ts';

const scratches: string[] = [];
const relays: TestRelay[] = [];
const pages: TestPage[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const page of pages.splice(0)) page.ws.terminate();
  for (const relay of relays.splice(0)) await relay.close();
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tabdock-audit-relay-')));
  scratches.push(dir);
  return dir;
}

function quiet(): void {
  // Swallow log lines.
}

/** Every record the relay's files hold, oldest first. */
function records(dir: string): ReturnType<typeof AuditLineSchema.parse>[] {
  return [...readAuditLines(dir)].map((line) => {
    if (line.record === null) throw new Error(`line ${String(line.lineNumber)} is no record`);
    return line.record;
  });
}

/** Everything the relay wrote to its audit files, as one text. */
function fileText(dir: string): string {
  return listAuditFiles(dir)
    .map((file) => readFileSync(join(dir, file.name), 'utf8'))
    .join('');
}

describe('a relay with an audit directory (ADR 0019)', () => {
  it('refuses production without one, naming the setting', async () => {
    const auth = createDevTokenAuth([ALICE]);
    await expect(
      createRelay({ auth, env: 'production', allowedOrigins: [PAGE_ORIGIN], logSink: quiet }),
    ).rejects.toThrow(/production keeps a persistent audit log: set TABDOCK_AUDIT_DIR/);
    // An embedder's own store answers for its own log instead.
    const relay = await createRelay({
      auth,
      env: 'production',
      allowedOrigins: [PAGE_ORIGIN],
      store: createMemoryStore(),
      logSink: quiet,
    });
    await relay.close();
    await expect(
      createRelay({ auth, audit: { dir: join(scratch(), 'a') }, store: createMemoryStore() }),
    ).rejects.toThrow(/an audit directory \(TABDOCK_AUDIT_DIR\) or a store of its own, not both/);
  });

  it('refuses production when the directory is unusable or relay_start cannot reach the disk', async () => {
    const auth = createDevTokenAuth([ALICE]);
    const base = { auth, env: 'production' as const, allowedOrigins: [PAGE_ORIGIN] };
    const root = scratch();
    // A plain file where the directory should be.
    const file = join(root, 'not-a-dir');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'x');
    await expect(createRelay({ ...base, audit: { dir: file }, logSink: quiet })).rejects.toThrow(
      /audit directory .*(EEXIST|is not a directory)/,
    );
    // A directory where today's first file must go: the directory opens, the write does not.
    const dir = join(root, 'audit');
    mkdirSync(join(dir, `audit-${utcDay(Date.now())}-000000000001.jsonl`), { recursive: true });
    await expect(createRelay({ ...base, audit: { dir }, logSink: quiet })).rejects.toThrow(
      /could not write and sync its relay_start record/,
    );
  });

  it('brackets a run with relay_start and relay_stop, and syncs the calls the shutdown fails before closing', async () => {
    const dir = join(scratch(), 'audit');
    const relay = await startRelay({
      env: 'production',
      allowedOrigins: [PAGE_ORIGIN],
      audit: { dir },
      timings: { callDeadlineMs: 5000 },
    });
    const page = await connectPage(relay.relay.pageUrl, { tools: TOOLS });
    pages.push(page);
    const alice = await connectClient(relay.relay, ALICE);
    clients.push(alice);
    await pairAndApprove(alice, page, 'driver');
    const running = callTool(alice, 'call_page_tool', {
      page: page.pageId,
      tool: 'add_item',
      arguments: { label: 'x' },
    });
    await page.next('invoke');
    await relay.close();
    await running.catch(() => undefined);
    const written = records(dir);
    // The approval writes its attach record (ADR 0019) before the call the shutdown fails.
    expect(written.map((record) => record.type)).toEqual([
      'relay_start',
      'attach',
      'call',
      'relay_stop',
    ]);
    expect(written[0]).toMatchObject({
      type: 'relay_start',
      seq: 1,
      prev: null,
      env: 'production',
      mode: 'dev_tokens',
      invites: false,
    });
    expect(written[1]).toMatchObject({ type: 'attach', userId: 'alice', via: 'code' });
    expect(written[2]).toMatchObject({ type: 'call', outcome: 'page_asleep', userId: 'alice' });
    expect(verifyAuditLines(readAuditLines(dir)).problems).toEqual([]);
    // The stderr copy is the file line, seq and prev included.
    const copy = relay.lines.find((line) => line.includes('"msg":"relay_start"')) ?? '';
    expect(copy).toContain('"seq":1');
    const stop = relay.lines.filter((line) => line.includes('"msg":"audit checkpoint"')).at(-1);
    expect(stop).toContain(
      `"head":"${lineHash(
        readFileSync(join(dir, listAuditFiles(dir)[0]?.name ?? ''), 'utf8')
          .trim()
          .split('\n')
          .at(-1) ?? '',
      )}"`,
    );

    // The next run goes on with the same chain.
    const again = await startRelay({
      env: 'production',
      allowedOrigins: [PAGE_ORIGIN],
      audit: { dir },
    });
    await again.close();
    const report = verifyAuditLines(readAuditLines(dir));
    expect(report).toMatchObject({ records: 6, lastSeq: 6, problems: [] });
  });

  it("keeps local mode's log in audit/ beside its owner token, 0700", async () => {
    const home = join(scratch(), 'tabdock');
    const options = loadConfigFromEnv({ TABDOCK_HOME: home, TABDOCK_PORT: '0' });
    const relay = await createRelay({ ...options, logSink: quiet });
    await relay.close();
    const dir = join(home, 'audit');
    if (process.platform !== 'win32') expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(
      records(dir).map((record) => [record.type, 'mode' in record ? record.mode : null]),
    ).toEqual([
      ['relay_start', 'local'],
      ['relay_stop', null],
    ]);
  });

  it('refuses a second relay on the same audit directory before it writes a line, in this process or another', async () => {
    const home = join(scratch(), 'tabdock');
    const dir = join(home, 'audit');
    const options = loadConfigFromEnv({ TABDOCK_HOME: home, TABDOCK_PORT: '0' });
    const first = await createRelay({ ...options, logSink: quiet });
    const port = new URL(first.url).port;
    // On a port of its own, and on the first relay's, where it could not listen anyway.
    for (const again of [options, loadConfigFromEnv({ TABDOCK_HOME: home, TABDOCK_PORT: port })]) {
      await expect(createRelay({ ...again, logSink: quiet })).rejects.toThrow(
        /audit directory .* is already open in this process/,
      );
    }
    await first.close();
    expect(records(dir).map((record) => record.type)).toEqual(['relay_start', 'relay_stop']);

    // pnpm relay while pnpm dev already runs: the other process holds the lock.
    const other = startMain({ TABDOCK_HOME: home });
    await other.port;
    await expect(createRelay({ ...options, logSink: quiet })).rejects.toThrow(
      new RegExp(`in use by another relay, pid ${String(other.child.pid)}`),
    );
    other.child.kill('SIGTERM');
    expect(await other.exited, other.output()).toEqual({ code: 0, signal: null });
    expect(records(dir).map((record) => record.type)).toEqual([
      'relay_start',
      'relay_stop',
      'relay_start',
      'relay_stop',
    ]);
    const report = verifyAuditLines(readAuditLines(dir));
    expect(report).toMatchObject({ records: 4, firstSeq: 1, lastSeq: 4, problems: [], torn: [] });
    // The lock goes with the relay that held it, so the next start finds none.
    const next = await createRelay({ ...options, logSink: quiet });
    await next.close();
    expect(verifyAuditLines(readAuditLines(dir)).problems).toEqual([]);
  });

  it('never writes a token, code, resume token, argument or client address to a file or a log line (S11)', async () => {
    const dir = join(scratch(), 'audit');
    const relay = await startRelay({ audit: { dir } });
    relays.push(relay);
    const page = await connectPage(relay.relay.pageUrl, {
      tools: [
        { ...TOOLS[0], inputSchema: { type: 'object' } } as (typeof TOOLS)[number],
        ...TOOLS.slice(1),
      ],
      onInvoke: () => ({ ok: true, content: 'done' }),
    });
    pages.push(page);
    const code = page.code;
    const resumeToken = page.welcome?.resumeToken ?? '';
    const alice = await connectClient(relay.relay, ALICE);
    clients.push(alice);
    await pairAndApprove(alice, page, 'driver');
    const marker = 'argument-marker-that-stays-out-of-the-log';
    await callTool(alice, 'call_page_tool', {
      page: page.pageId,
      tool: 'get_view',
      arguments: { note: marker },
    });
    // A stranger, a used code and a page id that is no id: refused, recorded, and still clean.
    const bob = await connectClient(relay.relay, BOB);
    clients.push(bob);
    await callTool(bob, 'pair_page', { code });
    await callTool(bob, 'call_page_tool', { page: `${page.pageId} ${marker}`, tool: 'get_view' });
    await relay.close();
    relays.splice(0);

    const text = fileText(dir);
    const logs = relay.lines.join('\n');
    expect(records(dir).some((record) => record.type === 'call')).toBe(true);
    for (const [where, haystack] of [
      ['audit files', text],
      ['log lines', logs],
    ] as const) {
      for (const token of [ALICE.token, BOB.token]) expect(haystack, where).not.toContain(token);
      expect(haystack, where).not.toContain(code);
      expect(haystack, where).not.toContain(resumeToken);
      expect(haystack, where).not.toContain(marker);
    }
    // The client's address is for log lines that need it, never for a record.
    expect(text).not.toContain('127.0.0.1');
  });
});

/** Whether text holds the bidi override or the escape character as themselves. */
function rawEscapes(text: string): boolean {
  return text.includes('\u202e') || text.includes('\u001b');
}

describe('pnpm audit:log', () => {
  /**
   * A relay run with two users' calls, one of them from a client whose name
   * holds escapes: relay_start, Alice's attach and call, Bob's refused call,
   * relay_stop.
   */
  async function populated(): Promise<string> {
    const dir = join(scratch(), 'audit');
    const relay = await startRelay({ audit: { dir } });
    const page = await connectPage(relay.relay.pageUrl, {
      tools: TOOLS,
      onInvoke: () => ({ ok: true, content: 'done' }),
    });
    pages.push(page);
    const alice = await connectClient(relay.relay, ALICE, {
      name: 'evil\u202e\u001b[31mclient',
    });
    clients.push(alice);
    await pairAndApprove(alice, page, 'driver');
    await callTool(alice, 'call_page_tool', { page: page.pageId, tool: 'get_view' });
    const bob = await connectClient(relay.relay, BOB);
    clients.push(bob);
    await callTool(bob, 'call_page_tool', { page: page.pageId, tool: 'get_view' });
    await relay.close();
    return dir;
  }

  function run(
    argv: string[],
    env: NodeJS.ProcessEnv = {},
    now?: number,
  ): { code: number; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    const code = runAuditCli(
      argv,
      env,
      {
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      },
      now,
    );
    return { code, out, err };
  }

  it('filters by user, type, outcome and time, and escapes what a client wrote', async () => {
    const dir = await populated();
    const all = run(['--dir', dir]);
    expect(all.code).toBe(0);
    expect(all.out).toHaveLength(5);
    expect(all.out[0]).toMatch(/^1 \d{4}-\d\d-\d\dT.* relay_start /);
    // Neither the bidi override nor the escape sequence reaches the terminal as itself.
    const joined = all.out.join('\n');
    expect(rawEscapes(joined)).toBe(false);
    expect(joined).toContain('\\u202e');
    expect(joined).toContain('\\u001b');

    expect(run(['--dir', dir, '--user', 'bob']).out).toHaveLength(1);
    expect(run(['--dir', dir, '--type', 'relay_start,relay_stop']).out).toHaveLength(2);
    expect(run(['--dir', dir, '--outcome', 'not_attached']).out[0]).toContain('userId="bob"');
    expect(run(['--dir', dir, '--since', '1h']).out).toHaveLength(5);
    // Each filter leaves something out: two hours on, the last hour holds nothing.
    expect(run(['--dir', dir, '--since', '1h'], {}, Date.now() + 2 * 3_600_000).out).toHaveLength(
      0,
    );
    const at = records(dir).map((record) => record.at);
    const since = new Date(Math.max(...at)).toISOString();
    expect(run(['--dir', dir, '--since', since]).out.length).toBeLessThan(5);
    // The page's attachment and calls, and nothing that names no page.
    const pageId = records(dir).find((record) => record.type === 'call' && 'pageId' in record);
    const page = pageId !== undefined && 'pageId' in pageId ? pageId.pageId : '';
    const onPage = run(['--dir', dir, '--page', page]).out;
    expect(onPage).toHaveLength(3);
    expect(onPage.map((line) => line.split(' ')[2])).toEqual(['attach', 'call', 'call']);
    expect(onPage.every((line) => line.includes(page))).toBe(true);
    expect(run(['--dir', dir, '--page', 'pg_another']).out).toHaveLength(0);
    expect(run(['--dir', dir, '--until', '2000-01-01T00:00:00Z']).out).toHaveLength(0);
    const json = run(['--dir', dir, '--json', '--type', 'call']).out;
    expect(json).toHaveLength(2);
    expect(AuditLineSchema.parse(JSON.parse(json[0] ?? '{}'))).toMatchObject({ type: 'call' });
    expect(rawEscapes(json.join('\n'))).toBe(false);
    // The directory may come from the environment instead.
    expect(run([], { TABDOCK_AUDIT_DIR: dir }).out).toHaveLength(5);
  });

  it('verifies the chain, against a checkpoint too, and exits 1 when it is broken', async () => {
    const dir = await populated();
    const ok = run(['--dir', dir, '--verify']);
    expect(ok.code).toBe(0);
    expect(ok.err.at(-1)).toMatch(
      /^verify: chain intact; 5 records in 1 files, seq 1 to 5, head [0-9a-f]{64}$/,
    );
    const head = /head ([0-9a-f]{64})/.exec(ok.err.at(-1) ?? '')?.[1] ?? '';
    expect(run(['--dir', dir, '--verify', '--checkpoint', `5:${head}`]).code).toBe(0);
    expect(run(['--dir', dir, '--verify', '--checkpoint', `5:${'0'.repeat(64)}`]).code).toBe(1);

    const [file] = listAuditFiles(dir);
    const path = join(dir, file?.name ?? '');
    const lines = readFileSync(path, 'utf8').split('\n');
    // Alice's call, after relay_start and her attach record.
    expect(lines[2]).toContain('"get_view"');
    lines[2] = (lines[2] ?? '').replace('"get_view"', '"add_item"');
    writeFileSync(path, lines.join('\n'));
    const broken = run(['--dir', dir, '--verify']);
    expect(broken.code).toBe(1);
    expect(broken.err.join('\n')).toMatch(/line 4: prev is not the digest of the previous record/);
    expect(broken.err.at(-1)).toMatch(/^verify: BROKEN/);
  });

  it('answers a usage error with 2 and the reason, never echoing a hostile argument raw', () => {
    expect(run(['--nonsense']).code).toBe(2);
    expect(run(['--type', 'everything', '--dir', scratch()]).err.join('\n')).toMatch(
      /unknown record type/,
    );
    expect(run(['--checkpoint', '1:abc', '--verify', '--dir', scratch()]).code).toBe(2);
    expect(run(['--checkpoint', `1:${'a'.repeat(64)}`, '--dir', scratch()]).err.join('\n')).toMatch(
      /--checkpoint needs --verify/,
    );
    expect(run(['--dir', join(scratch(), 'missing')]).code).toBe(2);
    expect(escapeForTerminal('a\u202eb\u0007c\u2028d')).toBe('a\\u202eb\\u0007c\\u2028d');
    expect(run(['--help']).out.join('\n')).toContain('Usage: pnpm audit:log');
  });
});

// One or more classes, each on a page of its own, as the classroom scenario
// has it (ADR 0044, A6.22; docs/plans/map-classroom.md), against main.ts as
// the image runs it: hosted mode behind a stand-in edge, the image's heap
// flag, invites on and every other setting at its default unless a run
// names it. Each page's teacher, a member, pairs their Claude and drives
// set_view every 2 s; the page runs the map profile, publishes about 4 KiB
// of state twice a second and answers images up to the relay's cap; the
// teacher starts a time-boxed session whose watch invites the class redeems
// at /i, each student's browser on an address of its own (or all on one, as
// behind a campus NAT). Each student then holds two 2025-11-25 sessions and
// a 2026-07-28 client with a listen stream.
//
// The phases follow the design's profiles. join (P4) is the classes
// arriving within half a minute under the shipped pairing and sign-in
// limits. class (P1 with images and proposals) reads state every 20 s, the
// view every 60 s, captures every 2 min and proposes a stop every 3 min, the
// teacher accepting one proposal every 20 s and dismissing the rest. agents
// (P2) has every student's agent loop wait_for_page_state at its
// 60-a-minute budget. Both run at the burst quota and then at Fly's 6.25%
// baseline. stalled (P3) has a quarter of each class leave a 0.72 MB answer
// and an image unread until the relay cuts them. ceiling has every student
// read two 0.72 MB answers at most 64 KiB every 25 s, so unread bytes pile
// up toward TABDOCK_MAX_RESPONSE_BYTES, past which the relay must cut
// guests' answers, while each teacher keeps two answers of their own
// waiting, read a little every 5 s, which must never be cut. Those two
// phases run with TCP buffers narrowed, so the relay rather than loopback's
// kernel holds what nobody reads (sockets.ts). Every answer left unread is
// settled at its phase's end by draining it (held.ts), so whether it was
// cut is the client's own finding. No token, secret, code or invite link is
// ever printed.

import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { DEFAULT_IMAGE_BYTES, MAX_RESULT_CHARS, MAX_INVITE_USES } from '@tabdock/protocol';
import { DEFAULT_RATE_LIMITS, EMAIL_CLAIM, EMAIL_VERIFIED_CLAIM } from '@tabdock/relay';
import { PAIR_CLIENT, startProvider, type TestProvider } from '@tabdock/relay/test/provider';
import {
  base64Of,
  type FakeToolDefinition,
  pngImage,
  type SimPage,
  startSimPage,
} from '@tabdock/sim-page';
import {
  createMapEditTools,
  createMapTools,
  createMapWorld,
  type MapCaptured,
} from '@tabdock/sim-page/map';
import {
  RESPONSE_CAP_LINE,
  RESPONSE_CEILING_LINE,
  RESPONSE_CUT_LINE,
} from '../../../../packages/relay/src/response-stalls.ts';
import { waitPageState } from '../state-helpers.ts';
import {
  applyQuota,
  BASELINE_QUOTA_US,
  BURST_QUOTA_US,
  type Confinement,
  type GroupStats,
} from './confine.ts';
import {
  edgeFetch,
  PUBLIC_HOST,
  PUBLIC_MCP_URL,
  type StatusSink,
  startPageEdge,
  StudentBrowser,
  type PageEdge,
} from './edge.ts';
import { type HeldAnswer, holdAnswer } from './held.ts';
import { narrowSocketBuffers, type NarrowScope } from './sockets.ts';
import { CallBook, CallLog, mib, round, sleep, Tally } from './stats.ts';

const ROOT = resolve(import.meta.dirname, '../../../..');
/** MEASURE_ROOM_DEBUG=1 prints each student's steps, never a secret. */
const debug = (line: string): void => {
  if (process.env.MEASURE_ROOM_DEBUG === '1') process.stderr.write(`debug: ${line}\n`);
};
const MAIN = join(ROOT, 'packages/relay/src/main.ts');
const PROBE = resolve(import.meta.dirname, 'probe.ts');
const PAGE_ORIGIN = 'https://class-map.test';
const PAGE_ADDRESS = '198.51.100.10';
const SHARED_ADDRESS = '203.0.113.250';
/** Students on addresses of their own take 203.0.113.1 onward, short of the shared one. */
export const MAX_STUDENTS = 249;
/** Unread answers each teacher keeps waiting through the ceiling phase. */
const MEMBER_HELD = 2;
/** How long settling may drain the answers left unread at a phase's end. */
const SETTLE_MS = 30_000;

/** How far apart a page's unread answers are asked for: just under the watchers' share of a page. */
export const FILL_SPACING_MS =
  Math.ceil(DEFAULT_RATE_LIMITS.windowMs / DEFAULT_RATE_LIMITS.watchingCallsPerPage) + 50;

/** The heap flag the image starts node with, read from the Dockerfile's CMD. */
export function imageHeapFlag(): string {
  const cmd = readFileSync(join(ROOT, 'Dockerfile'), 'utf8')
    .split('\n')
    .find((line) => line.startsWith('CMD '));
  const flag = (JSON.parse(cmd?.slice(4) ?? '[]') as string[]).find((arg) =>
    arg.startsWith('--max-old-space-size='),
  );
  if (flag === undefined) throw new Error('the Dockerfile CMD sets no --max-old-space-size');
  return flag;
}

/** Every relay setting .env.example names, blank, so a developer's .env cannot change the run. */
function blankSettings(): Record<string, string> {
  const names =
    readFileSync(join(ROOT, '.env.example'), 'utf8').match(/\bTABDOCK_[A-Z0-9_]+/g) ?? [];
  return Object.fromEntries(names.map((name) => [name, '']));
}

/** The relays a run has started and not yet seen exit, so an interrupt can stop them. */
const liveRelays = new Set<ChildProcess>();

/** Kills every relay still running, for a run cut short; its groups are then empty. */
export function killRelays(): void {
  for (const child of liveRelays) child.kill('SIGKILL');
}

export interface RoomPlan {
  /** Students in each class. */
  size: number;
  /** Classes at once, each on a page of its own with its own teacher. */
  pages: number;
  /** Settings beyond the defaults this run names, such as more watching seats. */
  settings: Record<string, string>;
  /** Every student on one address, as a class behind one NAT. */
  sharedAddress: boolean;
  /** Stop after the join, for the shared-address run. */
  joinOnly: boolean;
  /** Each phase's length after its ramp; the baseline phases take the agents' length. */
  phaseMs: { class: number; agents: number; stalled: number; ceiling: number };
  /** Where the join may spread each class's first taps. */
  joinSpreadMs: number;
  /** Whose TCP buffers the unread phases may narrow (sockets.ts). */
  narrow: NarrowScope;
}

export interface MemoryPeaks {
  vmRssMiB: number | null;
  vmHwmMiB: number | null;
  heapUsedMiB: number | null;
  externalMiB: number | null;
  arrayBuffersMiB: number | null;
  groupPeakMiB: number | null;
  /** What answers waiting to be read held as the response ceiling counts them, sampled every 2 s. */
  responsesHeldMiB: number | null;
}

export interface HeldTally {
  asked: number;
  /** whole, cut, open, or a refusal's code, once settled. */
  outcomes: Record<string, number>;
}

export interface PhaseResult {
  name: string;
  seconds: number;
  /** The CPU quota per 80 ms period the phase ran under, or null when none could be set. */
  quotaUs: number | null;
  peaks: MemoryPeaks;
  /** The heap after a collection taken while the phase's load still ran: what the bar reads. */
  heapAfterGcUnderLoadMiB: number | null;
  /** The same once the load stopped and its unread answers settled. */
  heapAfterGcMiB: number | null;
  /** The event loop's delay past the probe's 10 ms sampling interval. */
  eventLoopMs: { p50: number | null; p99: number | null; max: number | null };
  cpuMs: number | null;
  /** The relay's CPU per request /mcp answered in the phase. */
  cpuMsPerRequest: number | null;
  /** CPU time over wall time: 1 is one whole CPU. */
  cpuShare: number | null;
  throttledPeriods: number | null;
  throttledMs: number | null;
  oomKills: number | null;
  calls: ReturnType<CallBook['toJSON']>;
  statuses: Record<string, number>;
  logLines: Record<string, number>;
  /** Answers the relay cut, by rule, from its own lines and their repeat counts. */
  cuts: { stall: number; cap: number; ceiling: number };
  /** Students' answers left unread, settled by draining. */
  held: HeldTally;
  /** The teachers' answers left waiting, which must all end whole. */
  memberHeld: HeldTally;
  harnessLoopP99Ms: number | null;
}

export interface JoinResult {
  students: number;
  joined: number;
  /** Seconds from the first tap until the last student was approved. */
  allJoinedSeconds: number | null;
  /** How many were approved within 60 s of their class's first tap. */
  joinedInFirstMinute: number;
  signInRefusals: number;
  claimRefusals: Record<string, number>;
  /** Seconds each student waited from first tap to approval, as percentiles. */
  waitSeconds: { p50: number | null; p95: number | null; max: number | null };
  /** HTTP 503 from /mcp while strangers and guests opened sessions. */
  sessionRefusals: number;
}

export interface RoomResult {
  size: number;
  pages: number;
  settings: Record<string, string>;
  sharedAddress: boolean;
  confinement: { kind: string; cpu: number | null; notes: readonly string[] };
  answerBytes: { notes: number; capture: number };
  rosterFrameMaxBytes: number;
  join: JoinResult;
  phases: PhaseResult[];
  /** Phases left out, and why. */
  skipped: string[];
  /** How the unread phases narrowed TCP buffers, or why they could not (sockets.ts). */
  socketBuffers: string;
  relayExit: string;
}

/** What the probe inside the relay answers; every field is checked before use. */
interface ProbeMemory {
  vmRss: number;
  vmHwm: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  responsesHeld: number | null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function probeMemory(value: unknown): ProbeMemory | null {
  const raw = record(value);
  const vmRss = num(raw.vmRss);
  const vmHwm = num(raw.vmHwm);
  const heapUsed = num(raw.heapUsed);
  const external = num(raw.external);
  const arrayBuffers = num(raw.arrayBuffers);
  if (vmRss === null || vmHwm === null || heapUsed === null || external === null) return null;
  return {
    vmRss,
    vmHwm,
    heapUsed,
    external,
    arrayBuffers: arrayBuffers ?? 0,
    responsesHeld: num(raw.responsesHeld),
  };
}

/** The IPC side of probe.ts: one request at a time per id, each given up after a while. */
class ProbeChannel {
  #next = 1;
  readonly #waiting = new Map<number, (answer: Record<string, unknown> | null) => void>();

  readonly #child: ChildProcess;

  constructor(child: ChildProcess) {
    this.#child = child;
    child.on('message', (message: unknown) => {
      const answer = record(message);
      const id = num(answer.id);
      if (id === null) return;
      this.#waiting.get(id)?.(answer);
      this.#waiting.delete(id);
    });
  }

  ask(
    t: 'sample' | 'mark' | 'gc' | 'read',
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown> | null> {
    const id = this.#next;
    this.#next += 1;
    return new Promise((resolveAnswer) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        resolveAnswer(null);
      }, timeoutMs);
      this.#waiting.set(id, (answer) => {
        clearTimeout(timer);
        resolveAnswer(answer);
      });
      try {
        this.#child.send({ id, t });
      } catch {
        clearTimeout(timer);
        this.#waiting.delete(id);
        resolveAnswer(null);
      }
    });
  }
}

interface RelayProcess {
  child: ChildProcess;
  probe: ProbeChannel;
  url: string;
  exited: Promise<string>;
  /** Log lines, counted by level and message, into whichever tally the phase gives. */
  setLogSink(sink: Tally): void;
}

const LISTENING = /"msg":"relay listening".*?"bound":"[^"]*:(\d+)"/;

async function startRelay(
  confinement: Confinement,
  env: Record<string, string>,
): Promise<RelayProcess> {
  const argv = [
    process.execPath,
    imageHeapFlag(),
    '--expose-gc',
    '--import',
    pathToFileURL(PROBE).href,
    MAIN,
  ];
  const { command, args } = confinement.wrap(argv);
  const child = spawn(command, args, {
    env: { ...blankSettings(), PATH: process.env.PATH ?? '', TABDOCK_PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  liveRelays.add(child);
  let sink = new Tally();
  let output = '';
  let partial = '';
  const exited = new Promise<string>((resolveExit) => {
    child.once('exit', (code, signal) => {
      liveRelays.delete(child);
      resolveExit(signal ?? `code ${String(code)}`);
    });
  });
  const port = new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`the relay did not start:\n${output.slice(-4000)}`));
    }, 30_000);
    const look = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      if (output.length < 200_000) output += text;
      partial += text;
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('{')) continue;
        try {
          const parsed = record(JSON.parse(line));
          const level = typeof parsed.level === 'string' ? parsed.level : '?';
          const msg = typeof parsed.msg === 'string' ? parsed.msg : '?';
          // A window's summary of a repeated line counts as the lines it stands for.
          const repeated = msg.endsWith(', repeated') ? num(parsed.repeated) : null;
          const key = repeated === null ? msg : msg.slice(0, -', repeated'.length);
          if (level !== 'debug') sink.add(`${level} ${key}`, repeated ?? 1);
          if (level === 'warn' || level === 'error') debug(`relay: ${line.slice(0, 400)}`);
        } catch {
          // A torn line; the next one is whole.
        }
      }
      const found = LISTENING.exec(output);
      if (found !== null && output.includes('Tabdock relay on ')) {
        clearTimeout(timer);
        resolvePort(Number(found[1]));
      }
    };
    child.stdout?.on('data', look);
    child.stderr?.on('data', look);
    void exited.then((how) => {
      clearTimeout(timer);
      reject(new Error(`the relay exited (${how}) before listening:\n${output.slice(-4000)}`));
    });
  });
  port.catch(() => undefined);
  return {
    child,
    probe: new ProbeChannel(child),
    url: `http://127.0.0.1:${String(await port)}`,
    exited,
    setLogSink(next) {
      sink = next;
    },
  };
}

/** 120,000-odd characters that each leave the relay as six JSON bytes: the largest answer there is. */
const NOTES_TEXT = '\u0001'.repeat(MAX_RESULT_CHARS - 500);

/** A PNG of noise just under the relay's default image cap, so it compresses to no smaller. */
function noisePng(): { data: string; width: number; height: number } {
  for (let side = 150; side > 16; side -= 2) {
    const noise = randomBytes(side * side * 3);
    const bytes = pngImage({
      width: side,
      height: side,
      paint: (x, y) => {
        const at = (y * side + x) * 3;
        return [noise[at] ?? 0, noise[at + 1] ?? 0, noise[at + 2] ?? 0];
      },
    });
    if (bytes.length <= DEFAULT_IMAGE_BYTES - 1024) {
      return { data: base64Of(bytes), width: side, height: side };
    }
  }
  throw new Error('no noise PNG fits the image cap');
}

/** About 4 KiB of caption, different at every tick, so every state frame changes. */
function caption(tick: number): string {
  const words = ['crater', 'ridge', 'mare', 'rille', 'scarp', 'dome', 'basin', 'ray'];
  const parts: string[] = [];
  for (let n = 0; n < 512; n += 1) parts.push(words[(n * 7 + tick) % words.length] ?? 'rock');
  return parts.join(' ').slice(0, 4000);
}

/** One page with its teacher and class. */
interface Classroom {
  index: number;
  sim: SimPage;
  pageId: string;
  teacher: Client;
  teacherSub: string;
  teacherToken: string;
  /** A 2025-11-25 session of the teacher's, for answers they leave waiting. */
  teacherSessionId: string | null;
  secrets: string[];
}

interface Student {
  /** Across every class, for its address. */
  index: number;
  /** Within its own class, for its invite and its place in the join. */
  local: number;
  room: Classroom;
  sub: string;
  email: string;
  address: string;
  token: string;
  chatA: Client | null;
  chatB: Client | null;
  agent: Client | null;
  listening: { close(): Promise<void> } | null;
  joinedAt: number | null;
  lastVersion: number;
}

/** A tool answer's outcome: ok, or the code its error text starts with. */
function outcomeOf(result: { isError?: unknown; content?: unknown }): string {
  if (result.isError !== true) return 'ok';
  const first = Array.isArray(result.content) ? record(result.content[0]) : {};
  const text = typeof first.text === 'string' ? first.text : '';
  return /^([a-z_]+): /.exec(text)?.[1] ?? 'tool_error';
}

/** The error code a refusal at /i names, or nothing. */
function errorOf(data: Record<string, unknown>): string {
  return typeof data.error === 'string' ? data.error : '';
}

function thrownOutcome(error: unknown): string {
  if (error instanceof Error) {
    const code = record(error).code;
    const named = typeof code === 'number' || typeof code === 'string' ? ` ${String(code)}` : '';
    return `thrown ${error.name}${named}`;
  }
  return 'thrown';
}

function tallyOf(answers: readonly HeldAnswer[]): HeldTally {
  const outcomes = new Tally();
  for (const answer of answers) outcomes.add(answer.outcome);
  return { asked: answers.length, outcomes: outcomes.toJSON() };
}

class Phase {
  readonly calls = new CallBook();
  readonly statuses = new Tally();
  readonly logs = new Tally();
  readonly held: HeldAnswer[] = [];
  readonly memberHeld: HeldAnswer[] = [];
  readonly started = performance.now();
  peaks: MemoryPeaks = {
    vmRssMiB: null,
    vmHwmMiB: null,
    heapUsedMiB: null,
    externalMiB: null,
    arrayBuffersMiB: null,
    groupPeakMiB: null,
    responsesHeldMiB: null,
  };
  heapUnderLoadMiB: number | null = null;
  harnessDelays: number[] = [];
  groupAtStart: GroupStats | null = null;

  readonly name: string;
  readonly quotaUs: number | null;

  constructor(name: string, quotaUs: number | null) {
    this.name = name;
    this.quotaUs = quotaUs;
  }

  note(memory: ProbeMemory | null, group: GroupStats | null): void {
    const max = (old: number | null, next: number | null): number | null =>
      next === null ? old : old === null ? next : Math.max(old, next);
    if (memory !== null) {
      this.peaks.vmRssMiB = max(this.peaks.vmRssMiB, mib(memory.vmRss));
      this.peaks.vmHwmMiB = max(this.peaks.vmHwmMiB, mib(memory.vmHwm));
      this.peaks.heapUsedMiB = max(this.peaks.heapUsedMiB, mib(memory.heapUsed));
      this.peaks.externalMiB = max(this.peaks.externalMiB, mib(memory.external));
      this.peaks.arrayBuffersMiB = max(this.peaks.arrayBuffersMiB, mib(memory.arrayBuffers));
      this.peaks.responsesHeldMiB = max(this.peaks.responsesHeldMiB, mib(memory.responsesHeld));
    }
    if (group !== null) {
      this.peaks.groupPeakMiB = max(
        this.peaks.groupPeakMiB,
        mib(Math.max(group.usageBytes, group.peakBytes ?? 0)),
      );
    }
  }
}

/** Lists grouped by each student's page, in the order given. */
function byRoom<T extends { room: Classroom }>(items: readonly T[], pages: number): T[][] {
  const lists: T[][] = Array.from({ length: pages }, () => []);
  for (const item of items) lists[item.room.index]?.push(item);
  return lists;
}

export async function measureRoom(
  plan: RoomPlan,
  confinement: Confinement,
  say: (line: string) => void,
): Promise<RoomResult> {
  if (plan.size * plan.pages > MAX_STUDENTS) {
    throw new Error(`at most ${String(MAX_STUDENTS)} students in all`);
  }
  const scratch = realpathSync(mkdtempSync(join(ROOT, 'tests/e2e/test-results/measure-room-')));
  const cleanups: (() => Promise<unknown>)[] = [];
  let phase = new Phase('start', BURST_QUOTA_US);
  const sink: StatusSink = { current: () => phase.statuses };
  const phases: PhaseResult[] = [];
  const skipped: string[] = [];
  let relayExit = 'never started';
  let socketBuffers = 'not narrowed: no phase left answers unread';
  let result: RoomResult | null = null;
  const teacherSubs = Array.from({ length: plan.pages }, (_, n) => `sub-teacher-${String(n + 1)}`);
  try {
    const provider: TestProvider = await startProvider();
    cleanups.push(() => provider.stop());
    const relay = await startRelay(confinement, {
      NODE_ENV: 'production',
      TABDOCK_ENV: 'production',
      TABDOCK_HOST: '127.0.0.1',
      TABDOCK_PUBLIC_URL: `https://${PUBLIC_HOST}`,
      TABDOCK_OAUTH_ISSUER: provider.issuer,
      TABDOCK_OAUTH_USERS: teacherSubs
        .map((sub, n) => `${sub}=teacher${String(n + 1)}:Teacher ${String(n + 1)}`)
        .join(','),
      TABDOCK_PAIR_CLIENT_ID: PAIR_CLIENT.clientId,
      TABDOCK_PAIR_CLIENT_SECRET: PAIR_CLIENT.clientSecret,
      TABDOCK_ALLOWED_ORIGINS: PAGE_ORIGIN,
      TABDOCK_CLIENT_ADDRESS_HEADER: 'fly-client-ip',
      // The stand-in edge connects from loopback, so loopback is the edge's range.
      TABDOCK_TRUSTED_PROXY_CIDR: '127.0.0.1/32',
      TABDOCK_AUDIT_DIR: join(scratch, 'audit'),
      TABDOCK_INVITES: '1',
      ...plan.settings,
    });
    cleanups.push(async () => {
      relay.child.kill('SIGTERM');
      const ended = await Promise.race([relay.exited, sleep(10_000).then(() => 'still running')]);
      if (ended === 'still running') relay.child.kill('SIGKILL');
      relayExit = ended;
      // Its pipes and IPC channel go with it, so nothing holds this process open after the run.
      relay.child.stdout?.destroy();
      relay.child.stderr?.destroy();
      if (relay.child.connected) relay.child.disconnect();
    });
    relay.setLogSink(phase.logs);
    const edge: PageEdge = await startPageEdge(Number(new URL(relay.url).port), PAGE_ADDRESS);
    cleanups.push(() => edge.close());

    const tokenFor = (sub: string, email?: string): Promise<string> =>
      provider.token({
        sub,
        aud: PUBLIC_MCP_URL,
        ...(email === undefined ? {} : { [EMAIL_CLAIM]: email, [EMAIL_VERIFIED_CLAIM]: true }),
      });
    const clients: Client[] = [];
    cleanups.push(async () => {
      await Promise.allSettled(clients.map((client) => client.close()));
    });
    const connectClient = async (
      token: string,
      address: string,
      name: string,
      modern: boolean,
    ): Promise<Client> => {
      const client = new Client(
        { name, version: '1.0.0' },
        modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL(PUBLIC_MCP_URL), {
          fetch: edgeFetch(relay.url, address, sink),
          authProvider: { token: () => Promise.resolve(token) },
        }),
      );
      clients.push(client);
      return client;
    };

    // Each page: the map profile, a large read-only notes tool and images at the cap.
    const png = noisePng();
    const capture = (): Promise<MapCaptured> =>
      Promise.resolve({
        mimeType: 'image/png',
        data: png.data,
        widthPx: png.width,
        heightPx: png.height,
      });
    const notesTool: FakeToolDefinition = {
      name: 'read_notes',
      description: "Return the lesson's notes as text.",
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: () => NOTES_TEXT,
    };
    let rosterFrameMaxBytes = 0;
    const rooms: Classroom[] = [];
    for (let index = 0; index < plan.pages; index += 1) {
      const world = createMapWorld();
      const sim: SimPage = await startSimPage({
        relayUrl: edge.pageUrl,
        origin: PAGE_ORIGIN,
        title: `Class map ${String(index + 1)}`,
        policy: {
          consequentialTools: ['reset_edits'],
          imageTools: ['capture_view'],
          maxDrivers: 2,
          proposals: 'all',
        },
        operator: { askAttach: () => 'driver' },
        tools: () => [
          ...createMapTools(world, { capture }),
          ...createMapEditTools(world),
          notesTool,
        ],
      });
      cleanups.push(() => sim.close());
      await sim.waitFor((state) => state.link === 'linked' && state.pairing !== null, 20_000);
      sim.socket?.on('message', (data: Buffer) => {
        if (
          data.length > rosterFrameMaxBytes &&
          data.subarray(0, 40).toString().includes('"t":"roster"')
        ) {
          rosterFrameMaxBytes = data.length;
        }
      });
      // State twice a second, as a flyby playing its clock with a caption.
      let tick = 0;
      const publisher = setInterval(() => {
        tick += 1;
        sim.publishState({ ...world.state(), tick, caption: caption(tick) });
      }, 500);
      cleanups.push(() => {
        clearInterval(publisher);
        return Promise.resolve();
      });

      // The teacher pairs as a member and drives.
      const teacherSub = teacherSubs[index] ?? '';
      const teacherToken = await tokenFor(teacherSub);
      const teacher = await connectClient(teacherToken, PAGE_ADDRESS, 'claude-code', true);
      const paired = await teacher.callTool({
        name: 'pair_page',
        arguments: { code: sim.state.pairing?.code ?? '' },
      });
      if (paired.isError === true) throw new Error('a teacher could not pair');
      const pageId = String(record(paired.structuredContent).page);
      const started = await sim.dock.startSession({
        label: `Class ${String(index + 1)}`,
        lengthMinutes: 240,
        observers: plan.size,
        proposals: 'all',
      });
      if (!started.ok) throw new Error(`no session: ${started.reason}`);
      const secrets = started.links.map((link) => link.link.split('#')[1] ?? '');
      if (secrets.length < Math.ceil(plan.size / MAX_INVITE_USES)) {
        throw new Error('the session minted too few watch invites for the class');
      }
      // The teacher's second device, a 2025-era client, holds the answers they leave waiting.
      const second = await connectClient(teacherToken, PAGE_ADDRESS, 'claude-ai', false);
      rooms.push({
        index,
        sim,
        pageId,
        teacher,
        teacherSub,
        teacherToken,
        teacherSessionId: sessionOf(second),
        secrets,
      });
    }
    const [first] = rooms;
    if (first === undefined) throw new Error('no page');

    // How large each held answer is on the wire, read whole once by a teacher.
    const answerBytes = {
      notes: await answerSize(relay.url, first.teacherToken, first.pageId, 'read_notes'),
      capture: await answerSize(relay.url, first.teacherToken, first.pageId, 'capture_view'),
    };

    // Samples every 2 s into the running phase; the harness's own loop delay beside them.
    let lastTick = performance.now();
    const sampler = setInterval(() => {
      const now = performance.now();
      phase.harnessDelays.push(Math.max(0, now - lastTick - 2000));
      lastTick = now;
      void relay.probe.ask('sample', 5000).then((answer) => {
        phase.note(probeMemory(answer?.memory), confinement.stats());
      });
    }, 2000);
    cleanups.push(() => {
      clearInterval(sampler);
      return Promise.resolve();
    });

    /** Starts a phase under the quota it asks for, recording the one that applied. */
    const beginPhase = async (name: string, quotaUs: number): Promise<void> => {
      const applied = applyQuota(confinement, quotaUs);
      confinement.resetPeak();
      await relay.probe.ask('mark');
      phase = new Phase(name, applied);
      phase.groupAtStart = confinement.stats();
      relay.setLogSink(phase.logs);
      say(`  ${name}: started${applied === null ? ' (no CPU quota could be set)' : ''}`);
    };
    /** A collection while the load still runs: the heap that load keeps. */
    const underLoad = async (): Promise<void> => {
      const answer = await relay.probe.ask('gc', 60_000);
      phase.heapUnderLoadMiB = mib(num(answer?.heapAfterGc));
      phase.note(probeMemory(answer?.memory), confinement.stats());
    };
    const endPhase = async (): Promise<PhaseResult> => {
      await Promise.all(
        [...phase.held, ...phase.memberHeld].map((answer) => answer.settle(SETTLE_MS)),
      );
      const read = await relay.probe.ask('read', 60_000);
      const group = confinement.stats();
      phase.note(probeMemory(read?.memory), group);
      const loop = record(read?.eventLoop);
      const cpuMs = num(read?.cpuMs);
      const wallMs = num(read?.wallMs);
      const requests = Object.entries(phase.statuses.toJSON())
        .filter(([status]) => status.startsWith('http '))
        .reduce((sum, [, count]) => sum + count, 0);
      const at = phase.groupAtStart;
      const result: PhaseResult = {
        name: phase.name,
        seconds: round((performance.now() - phase.started) / 1000, 0) ?? 0,
        quotaUs: phase.quotaUs,
        peaks: phase.peaks,
        heapAfterGcUnderLoadMiB: phase.heapUnderLoadMiB,
        heapAfterGcMiB: mib(num(read?.heapAfterGc)),
        eventLoopMs: {
          p50: round(num(loop.p50)),
          p99: round(num(loop.p99)),
          max: round(num(loop.max)),
        },
        cpuMs: round(cpuMs, 0),
        cpuMsPerRequest: cpuMs === null || requests === 0 ? null : round(cpuMs / requests, 2),
        cpuShare:
          cpuMs === null || wallMs === null || wallMs === 0 ? null : round(cpuMs / wallMs, 3),
        throttledPeriods:
          group?.throttledPeriods == null || at?.throttledPeriods == null
            ? null
            : group.throttledPeriods - at.throttledPeriods,
        throttledMs:
          group?.throttledMs == null || at?.throttledMs == null
            ? null
            : round(group.throttledMs - at.throttledMs, 0),
        oomKills: group?.oomKills ?? null,
        calls: phase.calls.toJSON(),
        statuses: phase.statuses.toJSON(),
        logLines: phase.logs.toJSON(),
        cuts: {
          stall: phase.logs.get(`warn ${RESPONSE_CUT_LINE}`),
          cap: phase.logs.get(`warn ${RESPONSE_CAP_LINE}`),
          ceiling: phase.logs.get(`warn ${RESPONSE_CEILING_LINE}`),
        },
        held: tallyOf(phase.held),
        memberHeld: tallyOf(phase.memberHeld),
        harnessLoopP99Ms: round(
          phase.harnessDelays.length === 0
            ? null
            : ([...phase.harnessDelays].sort((a, b) => a - b)[
                Math.ceil(0.99 * phase.harnessDelays.length) - 1
              ] ?? null),
        ),
      };
      phases.push(result);
      say(
        `  ${result.name}: RSS ${String(result.peaks.vmRssMiB)} MiB, heap ${String(result.peaks.heapUsedMiB)} MiB, held ${String(result.peaks.responsesHeldMiB)} MiB, loop p99 ${String(result.eventLoopMs.p99)} ms, CPU ${String(result.cpuShare)}`,
      );
      return result;
    };

    const timed = async (
      kind: string,
      run: () => Promise<{ isError?: unknown; content?: unknown }>,
    ): Promise<{ isError?: unknown; content?: unknown; structuredContent?: unknown } | null> => {
      const log: CallLog = phase.calls.of(kind);
      const start = performance.now();
      try {
        const result = await run();
        const outcome = outcomeOf(result);
        log.record(outcome, performance.now() - start);
        if (outcome !== 'ok') debug(`${kind}: ${JSON.stringify(result.content).slice(0, 300)}`);
        return result;
      } catch (error) {
        log.record(thrownOutcome(error), performance.now() - start);
        return null;
      }
    };

    /** A tools/call on a 2025-era session whose answer its client reads slowly or not at all. */
    const hold = (
      who: { token: string; address: string },
      sessionId: string,
      pageId: string,
      tool: string,
      mode: 'stall' | 'trickle',
      everyMs = 25_000,
    ): HeldAnswer =>
      holdAnswer({
        url: new URL('/mcp', relay.url),
        headers: {
          host: PUBLIC_HOST,
          'fly-client-ip': who.address,
          authorization: `Bearer ${who.token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId,
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: nextHeldId(),
          method: 'tools/call',
          params: { name: 'call_page_tool', arguments: { page: pageId, tool, arguments: {} } },
        }),
        mode,
        takeBytes: 65_536,
        everyMs,
        onStatus: (status) => {
          sink.current().add(`http ${String(status)}`);
        },
      });

    // Each teacher drives all through, from the join on.
    // Flags the loops read after each await, so they live on an object.
    const flags = { teaching: true, operating: true };
    const teacherLoops = rooms.map((room) =>
      (async () => {
        let n = 0;
        while (flags.teaching) {
          n += 1;
          const due = performance.now() + 2000;
          await timed('teacher set_view', () =>
            room.teacher.callTool({
              name: 'call_page_tool',
              arguments: {
                page: room.pageId,
                tool: 'set_view',
                arguments: {
                  lon: ((n * 37) % 340) - 170,
                  lat: ((n * 13) % 120) - 60,
                  widthM: 750_000,
                },
              },
            }),
          );
          await sleep(Math.max(0, due - performance.now()));
        }
      })(),
    );

    // P4, the join: each class's students tap within joinSpreadMs, add the
    // connector (a stranger's session), sign in at /i and join by their
    // session's invite, tapping Join again 10 s after a refusal, as a person would.
    await beginPhase('join', BURST_QUOTA_US);
    const students: Student[] = [];
    for (const room of rooms) {
      for (let local = 0; local < plan.size; local += 1) {
        const index = students.length;
        const sub = `sub-student-${String(index)}`;
        const email = `student${String(index)}@example.com`;
        students.push({
          index,
          local,
          room,
          sub,
          email,
          address: plan.sharedAddress ? SHARED_ADDRESS : `203.0.113.${String(index + 1)}`,
          token: await tokenFor(sub, email),
          chatA: null,
          chatB: null,
          agent: null,
          listening: null,
          joinedAt: null,
          lastVersion: 0,
        });
      }
    }
    const tapAt = (student: Student): number =>
      (student.local * plan.joinSpreadMs) / Math.max(1, plan.size);
    const joinStart = performance.now();
    let signInRefusals = 0;
    let sessionRefusals = 0;
    const claimRefusals = new Tally();
    // The stand-in provider signs in whoever it was last told, so sign-ins take turns.
    let signInTurn: Promise<unknown> = Promise.resolve();
    const signIn = (student: Student, browser: StudentBrowser): Promise<boolean> => {
      const turn = signInTurn.then(async () => {
        provider.signInSubject = student.sub;
        provider.idTokenClaims = { email: student.email, email_verified: true };
        try {
          return await browser.signIn();
        } finally {
          provider.signInSubject = null;
          provider.idTokenClaims = null;
        }
      });
      signInTurn = turn.catch(() => undefined);
      return turn;
    };
    const joinOne = async (student: Student): Promise<void> => {
      await sleep(tapAt(student));
      const firstTap = performance.now();
      try {
        student.chatA = await connectClient(student.token, student.address, 'claude-ai', false);
      } catch (error) {
        debug(`student ${String(student.index)} connector: ${String(error)}`);
        sessionRefusals += 1;
      }
      debug(`student ${String(student.index)} connected`);
      const browser = new StudentBrowser(relay.url, student.address, sink);
      const secret = student.room.secrets[Math.floor(student.local / MAX_INVITE_USES)] ?? '';
      const deadline = firstTap + 10 * 60_000;
      // /i keeps a sign-in for 15 minutes, so a student signs in again only when it asks.
      let signedIn = false;
      while (performance.now() < deadline) {
        if (!signedIn) {
          signedIn = await signIn(student, browser);
          if (!signedIn) {
            debug(`student ${String(student.index)} sign-in refused`);
            signInRefusals += 1;
            await sleep(10_000);
            continue;
          }
        }
        const claimed = await browser.post('/i/claim', { secret });
        if (claimed.status === 401) signedIn = false;
        debug(
          `student ${String(student.index)} claim ${String(claimed.status)} ${errorOf(claimed.data)}`,
        );
        if (claimed.status !== 200) {
          claimRefusals.add(`${String(claimed.status)} ${errorOf(claimed.data)}`);
          await sleep(10_000);
          continue;
        }
        const claim = String(claimed.data.claim);
        let status = 'pending';
        while (status === 'pending' && performance.now() < deadline) {
          await sleep(100);
          status = String((await browser.post('/i/status', { claim })).data.status);
        }
        if (status === 'approved') {
          student.joinedAt = performance.now() - firstTap;
          return;
        }
        claimRefusals.add(`claim ${status}`);
        await sleep(10_000);
      }
    };
    await Promise.all(students.map((student) => joinOne(student)));
    const joinedTimes = students
      .map((student) => student.joinedAt)
      .filter((at): at is number => at !== null);
    const lastJoin = students.reduce(
      (latest, student) =>
        student.joinedAt === null ? latest : Math.max(latest, tapAt(student) + student.joinedAt),
      0,
    );
    const joinedWithinMinute = students.filter(
      (student) => student.joinedAt !== null && tapAt(student) + student.joinedAt <= 60_000,
    ).length;
    const sortedWaits = [...joinedTimes].sort((a, b) => a - b);
    const at = (p: number): number | null =>
      round((sortedWaits[Math.max(0, Math.ceil(p * sortedWaits.length) - 1)] ?? NaN) / 1000);
    const total = plan.size * plan.pages;
    const joinResult: JoinResult = {
      students: total,
      joined: joinedTimes.length,
      allJoinedSeconds:
        joinedTimes.length === total ? round((performance.now() - joinStart) / 1000) : null,
      joinedInFirstMinute: joinedWithinMinute,
      signInRefusals,
      claimRefusals: claimRefusals.toJSON(),
      waitSeconds: {
        p50: sortedWaits.length === 0 ? null : at(0.5),
        p95: sortedWaits.length === 0 ? null : at(0.95),
        max: sortedWaits.length === 0 ? null : round((sortedWaits.at(-1) ?? 0) / 1000),
      },
      sessionRefusals,
    };
    say(
      `  join: ${String(joinResult.joined)} of ${String(total)} in ${String(joinResult.allJoinedSeconds)} s (${String(round(lastJoin / 1000))} s to the last), ${String(joinedWithinMinute)} in the first minute`,
    );
    // The second device and the agent, now that each holds an attachment.
    await Promise.all(
      students.map(async (student) => {
        try {
          student.chatA ??= await connectClient(student.token, student.address, 'claude-ai', false);
          student.chatB = await connectClient(
            student.token,
            student.address,
            'claude-mobile',
            false,
          );
          student.agent = await connectClient(student.token, student.address, 'claude-code', true);
          student.listening = await student.agent.listen({ toolsListChanged: true });
        } catch {
          sessionRefusals += 1;
        }
      }),
    );
    joinResult.sessionRefusals = sessionRefusals;
    await underLoad();
    await endPhase();
    if (plan.joinOnly) {
      flags.teaching = false;
      await Promise.all(teacherLoops);
      return (result = finish());
    }

    const attached = students.filter((student) => student.joinedAt !== null);
    // Each operator accepts the oldest proposal every 20 s and dismisses the rest.
    const operatorLoops = rooms.map((room) =>
      (async () => {
        while (flags.operating) {
          await sleep(20_000);
          const [oldest] = room.sim.state.proposals;
          if (oldest !== undefined) {
            room.sim.acceptProposal(oldest.proposalId);
            room.sim.dismissAllProposals();
          }
        }
      })(),
    );

    // P1 with images and proposals. A chat is one conversation, so its calls
    // go one at a time, each when it falls due; the second device reads the
    // state on its own. Each student's first calls are staggered.
    const classLoad = (options: { pageCalls: boolean }): { stop(): Promise<void> } => {
      const state = { on: true };
      // Read through a call, so the check after each await sees a stop made meanwhile.
      const live = (): boolean => state.on;
      const until = async (at: number): Promise<void> => {
        while (live() && performance.now() < at)
          await sleep(Math.min(1000, at - performance.now()));
      };
      const loops: Promise<void>[] = [];
      for (const student of attached) {
        const { chatA, chatB } = student;
        const { pageId } = student.room;
        if (chatA === null || chatB === null) continue;
        const pageCall = (kind: string, tool: string, args: Record<string, unknown>) =>
          timed(kind, () =>
            chatA.callTool({
              name: 'call_page_tool',
              arguments: { page: pageId, tool, arguments: args },
            }),
          );
        const actions: { periodMs: number; run: () => Promise<unknown> }[] = [
          {
            periodMs: 20_000,
            run: () =>
              timed('get_page_state', () =>
                chatA.callTool({ name: 'get_page_state', arguments: { page: pageId } }),
              ),
          },
        ];
        if (options.pageCalls) {
          actions.push(
            { periodMs: 60_000, run: () => pageCall('get_view', 'get_view', {}) },
            { periodMs: 120_000, run: () => pageCall('capture_view', 'capture_view', {}) },
            {
              periodMs: 180_000,
              run: async () => {
                const proposed = await pageCall('propose go_to_stop', 'go_to_stop', {
                  walkthroughId: 'flyby',
                  index: student.local % 3,
                });
                const proposal = record(proposed?.structuredContent).proposal;
                if (typeof proposal !== 'string') return;
                await timed('get_proposal (waits)', () =>
                  chatA.callTool(
                    { name: 'get_proposal', arguments: { page: pageId, proposal, waitMs: 25_000 } },
                    { timeout: 60_000 },
                  ),
                );
              },
            },
          );
        }
        loops.push(
          (async () => {
            const begun = performance.now();
            const due = actions.map(
              (action, n) => begun + 500 + ((student.local * 7919 + n * 4111) % action.periodMs),
            );
            while (live()) {
              let next = 0;
              for (let n = 1; n < due.length; n += 1) {
                if ((due[n] ?? Infinity) < (due[next] ?? Infinity)) next = n;
              }
              await until(due[next] ?? Infinity);
              const action = actions[next];
              if (!live() || action === undefined) break;
              await action.run();
              due[next] = (due[next] ?? 0) + action.periodMs;
            }
          })(),
        );
        loops.push(
          (async () => {
            let at = performance.now() + 500 + ((student.local * 6007) % 60_000);
            while (live()) {
              await until(at);
              if (!live()) break;
              await timed('get_page_state (second device)', () =>
                chatB.callTool({ name: 'get_page_state', arguments: { page: pageId } }),
              );
              at += 60_000;
            }
          })(),
        );
      }
      return {
        async stop() {
          state.on = false;
          await Promise.all(loops);
        },
      };
    };

    // P2: every agent waits on the state at its budget, the chat quiet.
    const agentLoad = (): { stop(): Promise<void> } => {
      const state = { on: true };
      // Read through a call, so the check after each await sees a stop made meanwhile.
      const live = (): boolean => state.on;
      const loops = attached.map((student) =>
        (async () => {
          const agent = student.agent;
          if (agent === null) return;
          await sleep((student.index * 997) % 1100);
          while (live()) {
            const due = performance.now() + 1100;
            const start = performance.now();
            try {
              const read = await waitPageState(
                agent,
                student.room.pageId,
                student.lastVersion,
                25_000,
              );
              phase.calls
                .of('wait_for_page_state')
                .record(read.ok ? 'ok' : (read.code ?? 'tool_error'), performance.now() - start);
              if (read.ok) student.lastVersion = read.body.version;
            } catch (error) {
              phase.calls
                .of('wait_for_page_state')
                .record(thrownOutcome(error), performance.now() - start);
            }
            while (live() && performance.now() < due) await sleep(due - performance.now());
          }
        })(),
      );
      return {
        async stop() {
          state.on = false;
          await Promise.all(loops);
        },
      };
    };

    const runPhase = async (
      name: string,
      quotaUs: number,
      ms: number,
      start: () => { stop(): Promise<void> },
    ): Promise<void> => {
      await beginPhase(name, quotaUs);
      const load = start();
      await sleep(ms);
      await underLoad();
      await load.stop();
      await endPhase();
    };
    await runPhase('class', BURST_QUOTA_US, plan.phaseMs.class, () =>
      classLoad({ pageCalls: true }),
    );
    await runPhase('agents', BURST_QUOTA_US, plan.phaseMs.agents, agentLoad);
    // Only where a quota can be set, so a phase never claims a baseline it did not run at.
    if (applyQuota(confinement, BASELINE_QUOTA_US) === null) {
      skipped.push(
        'class and agents at the 6.25% baseline: the confinement could not set a CPU quota',
      );
    } else {
      await runPhase('class at the 6.25% baseline', BASELINE_QUOTA_US, plan.phaseMs.agents, () =>
        classLoad({ pageCalls: true }),
      );
      await runPhase(
        'agents at the 6.25% baseline',
        BASELINE_QUOTA_US,
        plan.phaseMs.agents,
        agentLoad,
      );
    }
    applyQuota(confinement, BURST_QUOTA_US);
    await sleep(5000);

    // Asks for each item, one per page every FILL_SPACING_MS, so no page's
    // watchers pass their share of its calls, until `ends`.
    const paced = async <T extends { room: Classroom }>(
      items: readonly T[],
      ask: (item: T) => void,
      ends = Infinity,
    ): Promise<void> => {
      const lists = byRoom(items, plan.pages);
      const steps = Math.max(0, ...lists.map((list) => list.length));
      for (let step = 0; step < steps; step += 1) {
        if (performance.now() > ends) break;
        for (const list of lists) {
          const item = list[step];
          if (item !== undefined) ask(item);
        }
        await sleep(FILL_SPACING_MS);
      }
    };

    // P3: a quarter of each class leaves a large answer and an image unread,
    // through an edge that buffers little (sockets.ts).
    const narrowed = narrowSocketBuffers(plan.narrow);
    socketBuffers = narrowed.note;
    say(`  ${narrowed.note}`);
    cleanups.push(() => {
      narrowed.restore();
      return Promise.resolve();
    });
    await beginPhase('stalled', BURST_QUOTA_US);
    let load = classLoad({ pageCalls: true });
    const quarter = attached
      .filter((student) => student.local % 4 === 0)
      .flatMap((student) =>
        ['read_notes', 'capture_view'].map((tool) => ({ student, tool, room: student.room })),
      );
    await paced(quarter, ({ student, tool }) => {
      const sessionId = sessionOf(student.chatB);
      if (sessionId !== null) {
        phase.held.push(hold(student, sessionId, student.room.pageId, tool, 'stall'));
      }
    });
    await sleep(plan.phaseMs.stalled);
    await underLoad();
    await load.stop();
    await endPhase();

    // Unread bytes toward the ceiling: every student reads two of the largest
    // answers slowly, while each teacher keeps two of their own waiting.
    await beginPhase('ceiling', BURST_QUOTA_US);
    load = classLoad({ pageCalls: false });
    const holding = { on: true };
    const memberLoops = rooms.map((room) =>
      (async () => {
        const sessionId = room.teacherSessionId;
        if (sessionId === null) return;
        const teacherAt = { token: room.teacherToken, address: PAGE_ADDRESS };
        const waiting = new Set<HeldAnswer>();
        while (holding.on) {
          while (waiting.size < MEMBER_HELD) {
            // Read a little every 5 s: always progress at the relay's 10 s checks, so
            // only the ceiling could take it, and the ceiling never takes a member's.
            const answer = hold(teacherAt, sessionId, room.pageId, 'read_notes', 'trickle', 5000);
            phase.memberHeld.push(answer);
            waiting.add(answer);
            void answer.done.then(() => waiting.delete(answer));
          }
          await sleep(1000);
        }
      })(),
    );
    const fillEnds = performance.now() + plan.phaseMs.ceiling;
    await paced(
      attached.flatMap((student) => [student, student]),
      (student) => {
        const sessionId = sessionOf(student.chatB);
        if (sessionId !== null) {
          phase.held.push(hold(student, sessionId, student.room.pageId, 'read_notes', 'trickle'));
        }
      },
      fillEnds,
    );
    await sleep(Math.max(0, fillEnds - performance.now()));
    await underLoad();
    holding.on = false;
    await Promise.all(memberLoops);
    await load.stop();
    await endPhase();
    narrowed.restore();

    flags.operating = false;
    flags.teaching = false;
    await Promise.all([...operatorLoops, ...teacherLoops]);
    return (result = finish());

    function finish(): RoomResult {
      return {
        size: plan.size,
        pages: plan.pages,
        settings: plan.settings,
        sharedAddress: plan.sharedAddress,
        confinement: { kind: confinement.kind, cpu: confinement.cpu, notes: confinement.notes },
        answerBytes,
        rosterFrameMaxBytes,
        join: joinResult,
        phases,
        skipped,
        socketBuffers,
        relayExit: 'running',
      };
    }
  } finally {
    for (const close of cleanups.reverse()) await close().catch(() => undefined);
    rmSync(scratch, { recursive: true, force: true });
    // The returned result is this object, so the relay's way out reaches the report.
    if (result !== null) result.relayExit = relayExit;
  }
}

let heldIds = 1000;

function nextHeldId(): number {
  heldIds += 1;
  return heldIds;
}

function sessionOf(client: Client | null): string | null {
  const transport = client?.transport;
  return transport instanceof StreamableHTTPClientTransport ? (transport.sessionId ?? null) : null;
}

/** One answer read whole, by a teacher, for its size on the wire. */
async function answerSize(
  relayUrl: string,
  token: string,
  pageId: string,
  tool: string,
): Promise<number> {
  return new Promise((resolveSize, reject) => {
    const req = httpRequest(
      new URL('/mcp', relayUrl),
      {
        method: 'POST',
        agent: false,
        headers: {
          host: PUBLIC_HOST,
          'fly-client-ip': PAGE_ADDRESS,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/call',
          'mcp-name': 'call_page_tool',
        },
      },
      (res) => {
        let bytes = 0;
        let head = '';
        res.on('data', (chunk: Buffer) => {
          if (bytes === 0) head = chunk.subarray(0, 400).toString('utf8');
          bytes += chunk.length;
        });
        res.on('end', () => {
          debug(`${tool} answer: ${head.replaceAll('\u0001', '')}`);
          resolveSize(bytes);
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'call_page_tool',
          arguments: { page: pageId, tool, arguments: {} },
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'claude-code', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    );
  });
}

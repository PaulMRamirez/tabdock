// The latency half of the M3 spike (A3.3): connect to a relay's MCP URL with
// the client SDK, pair with a page or reuse an attachment, time warm-up calls
// and then sequential call_page_tool calls, and report nearest-rank p50 and p95
// with min and max. With the relay's spike flag on, each result carries the
// relay's own timestamps (spike.ts), which split every round trip into the part
// the relay saw (the page included) and the rest: tunnel, network and client.
// scripts/spike/latency.ts is the command; tests/e2e/test/spike-latency.test.ts
// runs this against a local relay.

import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  Client,
  type FetchLike,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { SPIKE_TIMING_META_KEY, type SpikeTiming, SpikeTimingSchema } from '@tabdock/relay';
import { markdownTable, summarise } from './stats.ts';

export const SPIKE_CLIENT = { name: 'tabdock-spike-latency', version: '0.0.0' };

export interface ConnectOptions {
  /** Speak MCP 2026-07-28 instead of the 2025 revision the SDK negotiates by default. */
  modern?: boolean;
}

function newClient(options: ConnectOptions): Client {
  return new Client(
    SPIKE_CLIENT,
    options.modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
}

/** A local relay with a dev token: the token goes in a header and nowhere else. */
export async function connectWithBearer(
  url: string,
  token: string,
  options: ConnectOptions = {},
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = newClient(options);
  await client.connect(transport);
  return client;
}

export interface OAuthOptions extends ConnectOptions {
  /** Shown the sign-in URL, for the owner to open in a browser on this machine. */
  showSignIn: (url: URL) => void;
  /** The loopback port the provider sends the browser back to; 0 picks a free one. */
  callbackPort?: number;
  /**
   * A client already registered with the provider, as a public client with
   * this loopback redirect. Without it the SDK registers one dynamically.
   */
  clientId?: string;
  /** How long to wait for the browser to come back, 5 minutes by default. */
  timeoutMs?: number;
  /** Stands in for fetch, so a test can play the tunnel. */
  fetch?: FetchLike;
}

/**
 * Waits on 127.0.0.1 for the provider's redirect. Only the first request to
 * /callback whose state matches counts; the page it gets back says nothing
 * more than whether sign-in went through.
 */
class LoopbackCallback {
  readonly #server: Server;
  readonly #state = randomBytes(16).toString('base64url');
  #settle: ((params: URLSearchParams) => void) | null = null;
  readonly received: Promise<URLSearchParams>;

  constructor() {
    this.received = new Promise((resolve) => {
      this.#settle = resolve;
    });
    this.#server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const ok = url.pathname === '/callback' && url.searchParams.get('state') === this.#state;
      response.writeHead(ok ? 200 : 400, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      });
      response.end(
        ok
          ? 'Signed in for the Tabdock latency spike. You can close this tab.'
          : 'Not a sign-in callback.',
      );
      if (ok) this.#settle?.(url.searchParams);
    });
  }

  get state(): string {
    return this.#state;
  }

  async listen(port: number): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, '127.0.0.1', () => {
        resolve();
      });
    });
    const address = this.#server.address();
    if (address === null || typeof address === 'string') throw new Error('no callback port');
    return `http://127.0.0.1:${String(address.port)}/callback`;
  }

  close(): void {
    this.#server.closeAllConnections();
    this.#server.close();
  }
}

/** Holds the sign-in in memory only: nothing is written to disk, and tokens are never printed. */
class SpikeOAuthProvider implements OAuthClientProvider {
  readonly #redirect: string;
  readonly #callback: LoopbackCallback;
  readonly #show: (url: URL) => void;
  #client: StoredOAuthClientInformation | undefined;
  #tokens: StoredOAuthTokens | undefined;
  #verifier = '';
  #discovery: OAuthDiscoveryState | undefined;

  constructor(
    redirect: string,
    callback: LoopbackCallback,
    show: (url: URL) => void,
    clientId: string | undefined,
  ) {
    this.#redirect = redirect;
    this.#callback = callback;
    this.#show = show;
    if (clientId !== undefined) this.#client = { client_id: clientId };
  }

  get redirectUrl(): string {
    return this.#redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Tabdock latency spike',
      redirect_uris: [this.#redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  state(): string {
    return this.#callback.state;
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    return this.#client;
  }

  saveClientInformation(info: StoredOAuthClientInformation): void {
    this.#client = info;
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.#tokens;
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    this.#tokens = tokens;
  }

  redirectToAuthorization(url: URL): void {
    this.#show(url);
  }

  saveCodeVerifier(verifier: string): void {
    this.#verifier = verifier;
  }

  codeVerifier(): string {
    return this.#verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.#discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.#discovery;
  }
}

/**
 * The public URL: the SDK's own OAuth flow, as Claude Code runs it. The first
 * request is refused with the relay's challenge, the SDK finds the provider
 * and shows a sign-in URL, the owner signs in in a browser on this machine, the
 * provider sends that browser back to a loopback port, and the code becomes a
 * token held in memory for this run.
 */
export async function connectWithOAuth(url: string, options: OAuthOptions): Promise<Client> {
  const callback = new LoopbackCallback();
  try {
    const redirect = await callback.listen(options.callbackPort ?? 0);
    const provider = new SpikeOAuthProvider(
      redirect,
      callback,
      options.showSignIn,
      options.clientId,
    );
    const transport = (): StreamableHTTPClientTransport =>
      new StreamableHTTPClientTransport(new URL(url), {
        authProvider: provider,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
    const first = transport();
    try {
      const client = newClient(options);
      await client.connect(first);
      return client;
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
    }
    const timeoutMs = options.timeoutMs ?? 5 * 60_000;
    let timer: NodeJS.Timeout | undefined;
    const params = await Promise.race([
      callback.received,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`no sign-in came back within ${String(timeoutMs / 1000)} s`));
        }, timeoutMs);
      }),
    ]).finally(() => {
      clearTimeout(timer);
    });
    if (params.has('error')) {
      throw new Error(`the provider refused sign-in: ${params.get('error') ?? ''}`);
    }
    await first.finishAuth(params);
    const client = newClient(options);
    await client.connect(transport());
    return client;
  } finally {
    callback.close();
  }
}

function text(content: readonly { type: string; text?: string }[]): string {
  return content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n');
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** The awake pages in a list_pages result. */
function awakePages(structured: unknown): string[] {
  const pages = field(structured, 'pages');
  if (!Array.isArray(pages)) return [];
  return pages
    .filter((entry) => field(entry, 'state') === 'awake')
    .map((entry) => field(entry, 'page'))
    .filter((page): page is string => typeof page === 'string');
}

export interface PageChoice {
  /** Pair with this code; the operator approves on the page. */
  code?: string;
  /** Reuse this attachment. */
  page?: string;
}

/**
 * The page to time. A code pairs (pair_page waits for the operator, up to the
 * relay's pair wait); a page id is used as it is; with neither, the one awake
 * page this user is attached to.
 */
export async function choosePage(client: Client, choice: PageChoice): Promise<string> {
  if (choice.page !== undefined) return choice.page;
  if (choice.code !== undefined) {
    const result = await client.callTool({ name: 'pair_page', arguments: { code: choice.code } });
    if (result.isError === true) throw new Error(`pair_page failed: ${text(result.content)}`);
    const paired = field(result.structuredContent, 'page');
    if (typeof paired !== 'string') throw new Error('pair_page answered without a page id');
    return paired;
  }
  const listed = await client.callTool({ name: 'list_pages', arguments: {} });
  const awake = awakePages(listed.structuredContent);
  const only = awake[0];
  if (awake.length !== 1 || only === undefined) {
    throw new Error(
      `name a page with --page or pair with --code; this user has ${String(awake.length)} awake pages attached`,
    );
  }
  return only;
}

export interface CallSample {
  /** At the client, from just before the request to the parsed result. */
  roundTripMs: number;
  /** The relay's timestamps, when its spike flag is on. */
  timing: SpikeTiming | null;
  ok: boolean;
}

export interface MeasureOptions {
  page: string;
  tool: string;
  args?: Record<string, unknown>;
  warmup: number;
  calls: number;
  onCall?: (index: number, total: number, sample: CallSample) => void;
}

/** Warm-up calls first, discarded; then the measured ones, one after another. */
export async function measureCalls(client: Client, options: MeasureOptions): Promise<CallSample[]> {
  const samples: CallSample[] = [];
  const total = options.warmup + options.calls;
  for (let index = 0; index < total; index += 1) {
    const started = performance.now();
    const result = await client.callTool({
      name: 'call_page_tool',
      arguments: { page: options.page, tool: options.tool, arguments: options.args ?? {} },
    });
    const roundTripMs = performance.now() - started;
    const timing = SpikeTimingSchema.safeParse(result._meta?.[SPIKE_TIMING_META_KEY]);
    const sample: CallSample = {
      roundTripMs,
      timing: timing.success ? timing.data : null,
      ok: result.isError !== true,
    };
    options.onCall?.(index, total, sample);
    if (index >= options.warmup) samples.push(sample);
  }
  return samples;
}

export interface ReportContext {
  /** Where the client connected: shown as its origin only. */
  url: string;
  tool: string;
  warmup: number;
  era: string;
  date?: Date;
}

/** The markdown section for docs/notes/spike.md. Failed calls are counted, not timed. */
export function latencyReport(samples: readonly CallSample[], context: ReportContext): string {
  const ok = samples.filter((sample) => sample.ok);
  const timed = ok.filter(
    (sample): sample is CallSample & { timing: SpikeTiming } => sample.timing !== null,
  );
  const pageTimed = timed.filter((sample) => sample.timing.pageMs !== null);
  const rows = [
    { label: 'Round trip at the client', summary: summarise(ok.map((s) => s.roundTripMs)) },
    {
      label: 'Relay, request in to response out (page included)',
      summary: summarise(timed.map((s) => s.timing.relayMs)),
    },
    {
      label: 'Page link and page handler',
      summary: summarise(pageTimed.map((s) => s.timing.pageMs ?? 0)),
    },
    {
      label: 'Relay without the page',
      summary: summarise(pageTimed.map((s) => s.timing.relayMs - (s.timing.pageMs ?? 0))),
    },
    {
      label: 'Tunnel, network and client (round trip minus relay)',
      summary: summarise(timed.map((s) => s.roundTripMs - s.timing.relayMs)),
    },
  ];
  const date = (context.date ?? new Date()).toISOString();
  const failed = samples.length - ok.length;
  const notes = [
    `Measured ${date} against ${new URL(context.url).origin}: ${String(context.warmup)} warm-up calls, then ${String(samples.length)} sequential call_page_tool ${context.tool} calls over MCP ${context.era}. Percentiles by nearest rank (for 50 calls, p50 is the 25th and p95 the 48th sorted value).`,
    timed.length === 0
      ? 'The relay sent no timestamps (its spike flag is off), so only the round trip is split out.'
      : `The relay's timestamps run from reading the request to handing the result to the SDK.`,
    failed === 0 ? 'Every call succeeded.' : `${String(failed)} calls failed and are left out.`,
  ];
  return `${markdownTable(rows)}\n\n${notes.join(' ')}\n`;
}

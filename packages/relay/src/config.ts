// Relay options, their defaults, and the checks that refuse an unsafe setup
// before anything listens: loopback only until TLS arrives in M4 (S12), and an
// explicit origin allowlist in production (S2). The section 9 limits and the
// session and attachment lifetimes follow ADR 0009.

import {
  ATTACH_REQUEST_TTL_MS,
  DEFAULT_CALL_DEADLINE_MS,
  IDLE_TIMEOUT_MS,
  PAIR_WAIT_MS,
  PAIRING_TTL_MS,
  PING_INTERVAL_MS,
  RESUME_WINDOW_MS,
} from '@tabdock/protocol';
import { type AuthPlugin, createDevTokenAuth, parseDevTokens } from './auth.ts';
import type { LogLevel, LogSink } from './log.ts';
import type { RelayStore } from './store.ts';

export type RelayEnv = 'development' | 'production';

export interface RelayTimings {
  pairingTtlMs: number;
  attachRequestTtlMs: number;
  pairWaitMs: number;
  resumeWindowMs: number;
  pingIntervalMs: number;
  idleTimeoutMs: number;
  helloTimeoutMs: number;
  /** The deadline the page gets for one call, sent in the invoke frame. */
  callDeadlineMs: number;
  /**
   * How long past callDeadlineMs the relay itself waits. The page's timer starts
   * only when the invoke arrives and answers at its deadline (an unanswered
   * confirmation as denied_by_operator, S6), so the relay must not give up first.
   */
  callDeadlineGraceMs: number;
  goneTombstoneMs: number;
  /** A 2025-era MCP session with no response open for this long is closed. */
  sessionIdleMs: number;
  /** An attachment with no call for this long, counted from its grant or last call, expires. */
  attachmentIdleMs: number;
  /** How often an open MCP event stream gets a keep-alive comment; the SDK's own default. */
  sseKeepAliveMs: number;
  /**
   * How long one argument check may wait for the check worker and then run in
   * it (ADR 0010). Past either, the call goes to the page unchecked, so a call
   * waits at most about twice this for its check.
   */
  argumentCheckMs: number;
}

export interface RelayRateLimits {
  /** pair_page attempts one user may make per window. */
  pairAttemptsPerUser: number;
  /** pair_page attempts one client address may make per window, across users. */
  pairAttemptsPerAddress: number;
  /** call_page_tool calls one user may make to one page per window (S9). */
  callsPerUserPerPage: number;
  /** The window every limit above counts over. */
  windowMs: number;
  /**
   * tools frames one page socket may send per toolsFramesWindowMs; past it the
   * socket is closed with 1008 (S9). Each frame prepares and hashes every tool's
   * schema for the argument check on the main thread (ADR 0008, ADR 0010), so a
   * page re-sending large ones could keep the relay busy.
   */
  toolsFramesPerSocket: number;
  /**
   * tools frames all page sockets from one remote address may send per
   * toolsFramesWindowMs, counted across reconnects; past it the socket that
   * sent the frame is closed with 1008 (S9). One address may hold
   * pageSocketsPerAddress sockets, so without this their budgets would add up.
   * Room for every page an address may hold by default to list its tools once,
   * as all of them do after a relay restart, and for one of them to use its
   * whole toolsFramesPerSocket besides.
   */
  toolsFramesPerAddress: number;
  /** Short, so a burst is caught at once while a page that changes its tools now and then never is. */
  toolsFramesWindowMs: number;
}

/** Capacities (S9, ADR 0009). Past one, the relay refuses rather than grows. */
export interface RelayLimits {
  /** 2025-era MCP sessions one user may hold; a new one evicts their least recently used idle one. */
  sessionsPerUser: number;
  /** 2025-era MCP sessions the relay holds in total. */
  sessions: number;
  /** Distinct users attached to one page. */
  usersPerPage: number;
  /** Mutating calls waiting behind the running one on one page. */
  queueDepth: number;
  /** Page sockets open from one remote address, refused before the upgrade past it. */
  pageSocketsPerAddress: number;
  /**
   * Page sessions, awake or asleep, created from one remote address. Past it a
   * new one ends that address's own page asleep longest, or is refused.
   */
  pageSessionsPerAddress: number;
  /**
   * Page sessions held in total, awake or asleep; also the most page sockets
   * open at once, and the most gone pages remembered for page_gone.
   */
  pageSessions: number;
}

export interface RelayOptions {
  auth: AuthPlugin;
  /** Default 127.0.0.1. Anything but loopback is refused until M4 brings TLS. */
  host?: string | undefined;
  /** Default 0, a free port; the CLI uses 8787. */
  port?: number | undefined;
  /** Default development. */
  env?: RelayEnv | undefined;
  /**
   * Page origins allowed to open /page. In development the default is http and
   * https on localhost, 127.0.0.1 and [::1] at any port; a list given here
   * replaces that default. Production refuses to start without one.
   */
  allowedOrigins?: readonly string[] | undefined;
  /** Development only: accept page sockets with no Origin header (the Node sim page). */
  allowMissingOrigin?: boolean | undefined;
  timings?: { [K in keyof RelayTimings]?: number | undefined } | undefined;
  rateLimits?: { [K in keyof RelayRateLimits]?: number | undefined } | undefined;
  limits?: { [K in keyof RelayLimits]?: number | undefined } | undefined;
  /** Receives every log line; stderr when absent. */
  logSink?: LogSink | undefined;
  logLevel?: LogLevel | undefined;
  /** Storage; in memory when absent. M4 swaps in a persistent audit log here. */
  store?: RelayStore | undefined;
}

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_CLI_PORT = 8787;
export const HELLO_TIMEOUT_MS = 10_000;
export const CALL_DEADLINE_GRACE_MS = 2000;
/** A gone page is remembered for as long as it could have slept, so callers learn it is gone. */
export const GONE_TOMBSTONE_MS = RESUME_WINDOW_MS;
export const SESSION_IDLE_MS = 30 * 60_000;
export const ATTACHMENT_IDLE_MS = 8 * 60 * 60_000;
export const SSE_KEEP_ALIVE_MS = 15_000;
/** ADR 0010: an ordinary check takes a millisecond or two, and a stall this short goes unnoticed. */
export const ARGUMENT_CHECK_MS = 50;
/**
 * The longest delay setTimeout honours. Node runs a longer one after 1 ms
 * instead, which would expire every attachment at once.
 */
export const MAX_TIMER_MS = 2_147_483_647;

export const DEFAULT_TIMINGS: RelayTimings = {
  pairingTtlMs: PAIRING_TTL_MS,
  attachRequestTtlMs: ATTACH_REQUEST_TTL_MS,
  pairWaitMs: PAIR_WAIT_MS,
  resumeWindowMs: RESUME_WINDOW_MS,
  pingIntervalMs: PING_INTERVAL_MS,
  idleTimeoutMs: IDLE_TIMEOUT_MS,
  helloTimeoutMs: HELLO_TIMEOUT_MS,
  callDeadlineMs: DEFAULT_CALL_DEADLINE_MS,
  callDeadlineGraceMs: CALL_DEADLINE_GRACE_MS,
  goneTombstoneMs: GONE_TOMBSTONE_MS,
  sessionIdleMs: SESSION_IDLE_MS,
  attachmentIdleMs: ATTACHMENT_IDLE_MS,
  sseKeepAliveMs: SSE_KEEP_ALIVE_MS,
  argumentCheckMs: ARGUMENT_CHECK_MS,
};

export const DEFAULT_RATE_LIMITS: RelayRateLimits = {
  pairAttemptsPerUser: 10,
  pairAttemptsPerAddress: 30,
  callsPerUserPerPage: 120,
  windowMs: 60_000,
  toolsFramesPerSocket: 10,
  toolsFramesPerAddress: 30,
  toolsFramesWindowMs: 10_000,
};

export const DEFAULT_LIMITS: RelayLimits = {
  sessionsPerUser: 20,
  sessions: 1000,
  usersPerPage: 10,
  queueDepth: 32,
  pageSocketsPerAddress: 20,
  pageSessionsPerAddress: 20,
  pageSessions: 1000,
};

/** What a header-less page socket is recorded as when the dev flag lets it in. */
export const NO_ORIGIN = '(no origin header)';

export interface ResolvedConfig {
  host: string;
  port: number;
  env: RelayEnv;
  loopback: boolean;
  allowMissingOrigin: boolean;
  isOriginAllowed: (origin: string) => boolean;
  /** For the startup log line: the list, or a note that the dev default applies. */
  originPolicy: string;
  timings: RelayTimings;
  rateLimits: RelayRateLimits;
  limits: RelayLimits;
}

const DEV_ORIGIN_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Exactly the three names the SDK's localhostHostValidation accepts in a Host
 * header, so a client that reaches the relay always passes that check.
 */
export function isLoopbackHost(host: string): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host.toLowerCase());
}

/** An Origin value must already be in serialised form: scheme, host, optional port, nothing else. */
export function parseOrigin(value: string): string | null {
  const url = URL.parse(value);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null;
  return url.origin === value ? url.origin : null;
}

export function resolveConfig(options: RelayOptions): ResolvedConfig {
  const env = options.env ?? 'development';
  // Checked at run time too: JavaScript callers and env parsing can pass anything.
  if (!(['development', 'production'] as const).includes(env)) {
    throw new Error('env must be development or production');
  }
  const host = options.host ?? DEFAULT_HOST;
  if (!isLoopbackHost(host)) {
    throw new Error(
      `refusing to bind ${host}: the relay listens only on loopback (127.0.0.1, ::1 or localhost) until TLS arrives in M4 (SPEC S12)`,
    );
  }
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('port must be an integer from 0 to 65535');
  }

  const allowMissingOrigin = options.allowMissingOrigin ?? false;
  if (allowMissingOrigin && env === 'production') {
    throw new Error(
      'allowMissingOrigin is a development flag; production requires an Origin header on every page socket (SPEC S1)',
    );
  }

  let isOriginAllowed: (origin: string) => boolean;
  let originPolicy: string;
  if (options.allowedOrigins === undefined) {
    if (env === 'production') {
      throw new Error(
        'production needs an explicit allowedOrigins list (TABDOCK_ALLOWED_ORIGINS); refusing to start (SPEC S2)',
      );
    }
    isOriginAllowed = (origin) => {
      const parsed = parseOrigin(origin);
      return parsed !== null && DEV_ORIGIN_HOSTS.has(new URL(parsed).hostname);
    };
    originPolicy = 'development default: http and https on localhost, 127.0.0.1 and [::1]';
  } else {
    if (options.allowedOrigins.length === 0) {
      throw new Error('allowedOrigins is empty; list at least one page origin (SPEC S2)');
    }
    const allowed = new Set<string>();
    for (const entry of options.allowedOrigins) {
      const parsed = parseOrigin(entry.trim());
      if (parsed === null) {
        throw new Error(
          `allowed origin "${entry}" is not an origin such as https://app.example or http://localhost:5173`,
        );
      }
      allowed.add(parsed);
    }
    isOriginAllowed = (origin) => allowed.has(origin);
    originPolicy = [...allowed].join(', ');
  }

  // Every timing ends up in a setTimeout, so it must fit one.
  const timings = positiveIntegers(DEFAULT_TIMINGS, options.timings, MAX_TIMER_MS);
  // A call that reached its page is timed for both together.
  if (timings.callDeadlineMs + timings.callDeadlineGraceMs > MAX_TIMER_MS) {
    throw new Error(
      `callDeadlineMs plus callDeadlineGraceMs must be at most ${String(MAX_TIMER_MS)}`,
    );
  }

  return {
    host,
    port,
    env,
    loopback: true,
    allowMissingOrigin,
    isOriginAllowed,
    originPolicy,
    timings,
    rateLimits: positiveIntegers(DEFAULT_RATE_LIMITS, options.rateLimits),
    limits: positiveIntegers(DEFAULT_LIMITS, options.limits),
  };
}

/** Defaults overridden by whatever was given, each a positive integer no larger than `max`. */
function positiveIntegers<T extends { [K in keyof T]: number }>(
  defaults: T,
  given: { [K in keyof T]?: number | undefined } | undefined,
  max = Number.MAX_SAFE_INTEGER,
): T {
  const out = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof T & string)[]) {
    const value = given?.[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${key} must be a positive integer`);
    }
    if (value > max) throw new Error(`${key} must be at most ${String(max)}`);
    out[key] = value as T[keyof T & string];
  }
  return out;
}

function parseFlag(name: string, value: string | undefined): boolean {
  if (value === undefined || value === '' || value === '0' || value.toLowerCase() === 'false') {
    return false;
  }
  if (value === '1' || value.toLowerCase() === 'true') return true;
  throw new Error(`${name} must be 1, true, 0 or false`);
}

/** An unset or empty variable is undefined, so the default applies. */
function parseCount(name: string, value: string | undefined): number | undefined {
  const text = value?.trim() ?? '';
  if (text === '') return undefined;
  if (!/^\d{1,9}$/.test(text) || Number(text) === 0) {
    throw new Error(`${name} must be a positive whole number`);
  }
  return Number(text);
}

/** Minutes in the environment, milliseconds in RelayOptions. */
function parseMinutes(name: string, value: string | undefined): number | undefined {
  const minutes = parseCount(name, value);
  if (minutes === undefined) return undefined;
  const ms = minutes * 60_000;
  if (ms > MAX_TIMER_MS) {
    throw new Error(`${name} must be at most ${String(Math.floor(MAX_TIMER_MS / 60_000))} minutes`);
  }
  return ms;
}

/**
 * Reads the relay's settings from the environment (normally process.env after
 * the repo-root .env is loaded). Auth comes from TABDOCK_DEV_TOKENS, the only
 * plugin M1 has. Errors name the variable, never its value, since a token may
 * sit in the wrong place.
 */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv): RelayOptions {
  const portText = env.TABDOCK_PORT?.trim();
  let port = DEFAULT_CLI_PORT;
  if (portText !== undefined && portText !== '') {
    if (!/^\d{1,5}$/.test(portText) || Number(portText) > 65_535) {
      throw new Error('TABDOCK_PORT must be an integer from 0 to 65535');
    }
    port = Number(portText);
  }

  const envName = env.TABDOCK_ENV?.trim() ?? '';
  if (envName !== '' && envName !== 'development' && envName !== 'production') {
    throw new Error('TABDOCK_ENV must be development or production');
  }

  const originsText = env.TABDOCK_ALLOWED_ORIGINS?.trim() ?? '';
  const allowedOrigins =
    originsText === ''
      ? undefined
      : originsText
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);

  const tokens = env.TABDOCK_DEV_TOKENS?.trim() ?? '';
  if (tokens === '') {
    throw new Error(
      'TABDOCK_DEV_TOKENS is not set; give it as user=token pairs, for example alice=<24+ random characters>',
    );
  }

  const host = env.TABDOCK_HOST?.trim();
  return {
    auth: createDevTokenAuth(parseDevTokens(tokens)),
    host: host === undefined || host === '' ? undefined : host,
    port,
    env: envName === '' ? 'development' : envName,
    allowedOrigins,
    allowMissingOrigin: parseFlag('TABDOCK_DEV_ALLOW_NO_ORIGIN', env.TABDOCK_DEV_ALLOW_NO_ORIGIN),
    timings: {
      sessionIdleMs: parseMinutes('TABDOCK_SESSION_IDLE_MINUTES', env.TABDOCK_SESSION_IDLE_MINUTES),
      attachmentIdleMs: parseMinutes(
        'TABDOCK_ATTACHMENT_IDLE_MINUTES',
        env.TABDOCK_ATTACHMENT_IDLE_MINUTES,
      ),
    },
    rateLimits: {
      callsPerUserPerPage: parseCount(
        'TABDOCK_MAX_CALLS_PER_MINUTE',
        env.TABDOCK_MAX_CALLS_PER_MINUTE,
      ),
    },
    limits: {
      sessionsPerUser: parseCount(
        'TABDOCK_MAX_SESSIONS_PER_USER',
        env.TABDOCK_MAX_SESSIONS_PER_USER,
      ),
      sessions: parseCount('TABDOCK_MAX_SESSIONS', env.TABDOCK_MAX_SESSIONS),
      usersPerPage: parseCount('TABDOCK_MAX_USERS_PER_PAGE', env.TABDOCK_MAX_USERS_PER_PAGE),
      queueDepth: parseCount('TABDOCK_MAX_QUEUE_DEPTH', env.TABDOCK_MAX_QUEUE_DEPTH),
      pageSocketsPerAddress: parseCount(
        'TABDOCK_MAX_PAGE_SOCKETS_PER_ADDRESS',
        env.TABDOCK_MAX_PAGE_SOCKETS_PER_ADDRESS,
      ),
      pageSessionsPerAddress: parseCount(
        'TABDOCK_MAX_PAGE_SESSIONS_PER_ADDRESS',
        env.TABDOCK_MAX_PAGE_SESSIONS_PER_ADDRESS,
      ),
      pageSessions: parseCount('TABDOCK_MAX_PAGE_SESSIONS', env.TABDOCK_MAX_PAGE_SESSIONS),
    },
  };
}

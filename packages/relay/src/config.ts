// Relay options, their defaults, and the checks that refuse an unsafe setup
// before anything listens: loopback only until TLS arrives in M4 (S12), and an
// explicit origin allowlist in production (S2).

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
}

export interface RelayRateLimits {
  /** pair_page attempts one user may make per window. */
  pairAttemptsPerUser: number;
  /** pair_page attempts one client address may make per window, across users. */
  pairAttemptsPerAddress: number;
  windowMs: number;
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
};

export const DEFAULT_RATE_LIMITS: RelayRateLimits = {
  pairAttemptsPerUser: 10,
  pairAttemptsPerAddress: 30,
  windowMs: 60_000,
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

  const timings = { ...DEFAULT_TIMINGS };
  for (const key of Object.keys(DEFAULT_TIMINGS) as (keyof RelayTimings)[]) {
    const value = options.timings?.[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${key} must be a positive integer`);
    }
    timings[key] = value;
  }
  const rateLimits = { ...DEFAULT_RATE_LIMITS };
  for (const key of Object.keys(DEFAULT_RATE_LIMITS) as (keyof RelayRateLimits)[]) {
    const value = options.rateLimits?.[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${key} must be a positive integer`);
    }
    rateLimits[key] = value;
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
    rateLimits,
  };
}

function parseFlag(name: string, value: string | undefined): boolean {
  if (value === undefined || value === '' || value === '0' || value.toLowerCase() === 'false') {
    return false;
  }
  if (value === '1' || value.toLowerCase() === 'true') return true;
  throw new Error(`${name} must be 1, true, 0 or false`);
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
  };
}

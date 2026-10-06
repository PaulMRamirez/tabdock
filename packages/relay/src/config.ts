// Relay options, their defaults, and the checks that refuse an unsafe setup
// before anything listens: loopback only, unless hosted mode puts the relay
// behind a host edge that terminates TLS (S12, ADR 0018), and an explicit
// origin allowlist in production (S2). Public URL mode (ADR 0014) puts
// an https address in front of the loopback relay through a tunnel: it brings
// production rules, only OAuth sign-in for that address, and the QR sign-in at
// /pair, which needs a client of its own at the provider. The section 9 limits
// and the session and attachment lifetimes follow ADR 0009. The M3 spike's
// measurement flag (ADR 0014) is refused in production. With no auth settings
// at all the relay runs in local mode (ADR 0022): one user, `you`, holding an
// owner token drawn into a private per-user file (local-token.ts), behind a
// plugin marked loopbackOnly, which resolveConfig keeps on this machine.
// M4's settings are read here too, each refused by name outside the mode
// where it means something: invites (ADR 0017), hosted mode's client address
// header and proxy ranges with its limits (ADR 0018), the audit log's
// directory and bounds (ADR 0019), and the OAuth token age cap and client
// list (ADR 0020). Hosted mode alone may bind 0.0.0.0, which a platform's
// proxy and health checks need; every other mode keeps M3's loopback rule.
// M5 adds two settings that every mode allows: first-class page tools (ADR
// 0025), off by default, and the origins /mcp accepts beside its mode's own
// (ADR 0027).

import { BlockList, isIP, isIPv6 } from 'node:net';
import { basename, dirname, isAbsolute, join } from 'node:path';
import {
  ATTACH_REQUEST_TTL_MS,
  DEFAULT_CALL_DEADLINE_MS,
  IDLE_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  MAX_TIMER_MS,
  MEMBER_RESERVED_SEATS,
  PAIR_WAIT_MS,
  PAIRING_TTL_MS,
  PING_INTERVAL_MS,
  type RelayMode,
  RESUME_WINDOW_MS,
} from '@tabdock/protocol';
import type { AuditDirNames } from './audit-file.ts';
import { type AuthPlugin, createDevTokenAuth, parseDevTokens } from './auth.ts';
import { CONFIRMATION_TTL_MS } from './confirm.ts';
import {
  GIVEN_HOME,
  LOCAL_USER,
  type LocalTokenSystem,
  loadOwnerToken,
  type PathNames,
  pathNames,
} from './local-token.ts';
import type { LogLevel, LogSink } from './log.ts';
import { createOAuthAuth, parseOAuthClientIds, parseOAuthUsers } from './oauth.ts';
import type { RelayStore } from './store.ts';
import { holdingTokenLock } from './token-lock.ts';

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
  /** How long a browser stays signed in at /pair, counted from sign-in. */
  pairSessionMs: number;
  /**
   * How long a question in the caller's client waits for its answer (ADR
   * 0026): a 2026-07-28 record's life and a 2025-era call's own timer. 120 s,
   * and never more; a test may shorten it.
   */
  confirmationTtlMs: number;
}

export interface RelayRateLimits {
  /** Pairing attempts one user may make per window: pair_page and QR claims together (S3). */
  pairAttemptsPerUser: number;
  /**
   * Pairings one page may receive per window, counted when a live code or QR
   * nonce of that page is used, whoever uses it. Never per address: behind a
   * tunnel every caller shares one (ADR 0016).
   */
  pairAttemptsPerPage: number;
  /** Times one QR nonce may be looked at through /pair/preview per window; a preview uses nothing up. */
  pairPreviewsPerNonce: number;
  /**
   * Code exchanges /pair/callback may make per window for the whole relay,
   * one for each sign-in that comes back from the provider. Each is a request
   * carrying the /pair client's secret, and anyone can send a callback, so
   * past this none goes out and the sign-in fails. Relay-wide, never per
   * address: behind a tunnel every caller shares one (ADR 0016).
   */
  pairSignIns: number;
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
  /**
   * Frames one page socket may send per windowMs that the relay ignores or
   * refuses, changing nothing, whose log lines are written: a frame of
   * unknown type after hello; a decision for no request of the page, live or
   * just ended; a set_role for no one attached, or that leaves the role as it
   * was; a revoke that ends nothing; an invite frame on a relay with invites
   * off, an invite_create refused, and an invite_cancel naming no live
   * invite. /page needs no credential, so past this their lines are held
   * back and counted into one line per address when the window ends; the
   * socket stays open, since a frame that only logs is no reason to end a
   * page (S9, ADR 0023). A decision for a request the relay just ended is
   * expected and never counted: the page's timer and an operator's click can
   * cross the end on the wire.
   */
  ignoredFramesPerSocket: number;
  /**
   * The same for all page sockets from one remote address, counted across
   * reconnects, so neither more sockets nor new ones start the count over;
   * past it the lines of the frame that passed it are held back, its socket
   * left open. Frames before hello never count here: the first frame must be
   * hello, and anything else closes its socket with 1008.
   */
  ignoredFramesPerAddress: number;
  /**
   * Lines the page connections from one remote address may write in full
   * per windowMs: an upgrade refused, a socket closed for its first frame,
   * its silence or its unread frames, a page connected, asleep or gone, a
   * sleeper ended to make room. /page needs no credential and each connection
   * writes a few, so past this they are counted, by message, into one line
   * per address when the window ends (ADR 0023's notes).
   */
  connectionLinesPerAddress: number;
  /**
   * Requests one member may make to /mcp per window, every tool counted,
   * checked right after sign-in and before the access check, so refusals
   * count too (ADR 0018), every 2026-07-28 subscriptions/listen (A4.3), and
   * every other 2026-07-28 request once, as it arrives, tools/list and
   * server/discover included (ADR 0030).
   */
  requestsPerUser: number;
  /** The same for an invitee, smaller since anyone can become one (ADR 0018). */
  requestsPerInvitee: number;
  /** Redemptions of one invite per window, whoever makes them (ADR 0017). */
  redemptionsPerInvite: number;
  /**
   * Sign-ins one client address may start at /pair and /i per window in
   * hosted mode, under the relay-wide pairSignIns; sized for carrier NAT
   * (ADR 0018, sign-in-gate.ts).
   */
  signInsPerAddress: number;
  /**
   * Refused requests that never reached a page which one member, or an
   * account holding an attachment, may write audit lines for per window;
   * past it they are counted in a refused_summary (ADR 0019).
   */
  auditRefusalsPerUser: number;
  /** The same, shared by every account holding no attachment (ADR 0019). */
  auditRefusalsForStrangers: number;
}

/**
 * Capacities (S9, ADR 0009). Past one, the relay refuses rather than grows.
 * The four session numbers also bound the 2026-07-28 leg's subscriptions/listen
 * streams, counted apart from sessions (listen-streams.ts, A4.3).
 */
export interface RelayLimits {
  /**
   * 2025-era MCP sessions one user may hold; a new one evicts their least
   * recently used idle one. Also listen streams, a new one ending their oldest.
   */
  sessionsPerUser: number;
  /** 2025-era MCP sessions the relay holds in total, and listen streams in total. */
  sessions: number;
  /**
   * Of those, the sessions all invitees may hold together: their own small
   * pool, evicted first when the relay is full (ADR 0016). A session gives way
   * only to someone ranked above its holder (a stranger's to a guest, a
   * guest's to a member) unless it is idle and the newcomer's rank is its
   * holder's own (sessions.ts, A4.3). Listen streams the same, never idle.
   */
  inviteeSessions: number;
  /**
   * Sessions one invitee may hold once it holds an attachment; until then it
   * may hold one (ADR 0016). Listen streams the same.
   */
  sessionsPerInvitee: number;
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
  /**
   * Browser sessions signed in at /pair held at once. Past it a new sign-in
   * ends the oldest session of an account that is not a member first.
   */
  pairSessions: number;
  /** Code exchanges /pair/callback may have waiting on the provider at once, for the whole relay. */
  pairSignInsInFlight: number;
  /** The same for one client address in hosted mode, across /pair and /i (ADR 0018, sign-in-gate.ts). */
  signInsInFlightPerAddress: number;
  /**
   * Heap all pages' tool lists and prepared schemas may hold together, each
   * page charged an upper bound on what its list holds rather than its
   * frame's size (heldBytes in hub.ts); a tools frame that would pass it is
   * refused with 1008 and counted against its address (S9, ADR 0018). At
   * least MAX_FRAME_BYTES.
   */
  toolBytes: number;
  /**
   * Heap the /mcp requests that may wait on a page (call_page_tool, and
   * pair_page while the operator decides) may hold together, each charged
   * what its body and its parsed copy are measured to hold (request-heap.ts,
   * set above what every shape in call-shapes.ts was measured to hold on
   * both legs) until it is answered; past it a call is refused page_busy and
   * a pairing rate_limited (S9, ADR 0018's notes). Invitees' requests
   * together may hold a quarter of it, or MIN_REQUEST_BYTES where a quarter
   * is less, and are refused the same way past that (ADR 0030); one
   * invitee's may hold a quarter of that, or MIN_REQUEST_BYTES where that is
   * less, and are refused rate_limited past it (ADR 0032). At least
   * MIN_REQUEST_BYTES, and with invites on at least twice that.
   */
  requestBytes: number;
  /**
   * The same for one user's requests, past which they are refused
   * rate_limited, so one account cannot spend the whole of requestBytes.
   * At least MIN_REQUEST_BYTES and at most requestBytes (ADR 0030).
   */
  requestBytesPerUser: number;
}

/**
 * The persistent audit log's place and bounds (ADR 0019). With no directory
 * the relay keeps the memory ring alone, as tests and dev tokens do; local
 * mode puts it beside its owner token, and production needs one.
 */
export interface ResolvedAudit {
  dir: string | null;
  /** How refusals name the directory and its files; its path with TABDOCK_AUDIT_DIR when null. */
  names: AuditDirNames | null;
  /** Files older than this many days are deleted, never the current one. */
  retentionDays: number;
  /** The oldest files go once all of them pass this many bytes, never the current one. */
  maxBytes: number;
}

/** A range of trusted proxy addresses in hosted mode, as TABDOCK_TRUSTED_PROXY_CIDR lists them. */
export interface ProxyRange {
  address: string;
  prefix: number;
  family: 'ipv4' | 'ipv6';
}

/** The relay's own client at the identity provider, for the browser sign-in at /pair. */
export interface PairClientOptions {
  clientId: string;
  clientSecret: string;
}

export interface RelayOptions {
  auth: AuthPlugin;
  /**
   * Default 127.0.0.1. Anything but loopback is refused, except 0.0.0.0 in
   * hosted mode (ADR 0018), and a name must resolve to loopback addresses
   * alone (relay.ts).
   */
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
  /**
   * Origins /mcp accepts in an Origin header besides its mode's own
   * (TABDOCK_MCP_ALLOWED_ORIGINS, ADR 0027): loopback http and https without
   * a public URL, the public origin with one. Each must be a serialised http
   * or https origin, compared exactly as written; any other entry stops the
   * relay at start. Allowed in every mode, and empty adds nothing. These admit
   * nothing to /page, and allowedOrigins admits nothing to /mcp.
   */
  mcpAllowedOrigins?: readonly string[] | undefined;
  /**
   * The https origin a tunnel serves the relay at, such as
   * https://relay.example. Setting it switches on public URL mode (ADR 0014):
   * its host passes the Host check, `<publicUrl>/mcp` is the resource OAuth
   * tokens must be issued for, production rules apply, `auth` must be the
   * oauth plugin for that resource, and /page refuses anything not local.
   */
  publicUrl?: string | undefined;
  /**
   * The client the QR page at /pair signs browsers in with, registered at the
   * provider with `<publicUrl>/pair/callback` as its redirect URI. Required in
   * public URL mode, refused without it.
   */
  pairClient?: PairClientOptions | undefined;
  timings?: { [K in keyof RelayTimings]?: number | undefined } | undefined;
  rateLimits?: { [K in keyof RelayRateLimits]?: number | undefined } | undefined;
  limits?: { [K in keyof RelayLimits]?: number | undefined } | undefined;
  /** Receives every log line; stderr when absent. */
  logSink?: LogSink | undefined;
  logLevel?: LogLevel | undefined;
  /**
   * Storage; in memory when absent, with the persistent audit log when an
   * audit directory is set (ADR 0019). Refused beside an audit directory: a
   * store of one's own brings its own audit log.
   */
  store?: RelayStore | undefined;
  /**
   * The M3 spike's measurements (ADR 0014, A3.3), off by default and refused
   * in production: a marker tool that can be added beside the five fixed tools
   * and announced to open sessions, a log line for every tools/list and every
   * stream a client opens, timestamps for each call_page_tool, and pairing
   * milestones. See spike.ts.
   */
  spike?: boolean | undefined;
  /**
   * Invites (TABDOCK_INVITES, ADRs 0016 and 0017), off unless exactly true:
   * signed-in accounts off the allowlist become invitees, and pages mint
   * invites in the widget. Refused with local mode's plugin, which serves one
   * user, and when usersPerPage leaves invites no seat. Off, the relay sends
   * pages no invites frame and answers every invitee with M3's 403.
   */
  invites?: boolean | undefined;
  /**
   * First-class page tools (TABDOCK_FIRST_CLASS_TOOLS, ADR 0025), off unless
   * exactly true, in every mode, local mode included, and allowed in
   * production: members' clients list each attached page's tools as
   * `<page id>__<tool>` beside the five fixed tools. Off, the tool surface is M4's.
   */
  firstClassTools?: boolean | undefined;
  /**
   * Hosted mode (ADR 0018): the one header a host edge in front of the relay
   * sets to the client's address, replacing any value a client sent. Only in
   * production with a public URL; client-address.ts reads it.
   */
  clientAddressHeader?: string | undefined;
  /**
   * Hosted mode: the address ranges the edge connects from, in CIDR form;
   * the header is believed only from a peer inside one. RFC 1918 by default.
   */
  trustedProxyCidr?: readonly string[] | undefined;
  /** The persistent audit log (ADR 0019): its directory, an absolute path, and its bounds. */
  audit?:
    | {
        dir?: string | undefined;
        retentionDays?: number | undefined;
        maxMb?: number | undefined;
        /** How refusals name the directory and its files; its path with TABDOCK_AUDIT_DIR unless given. */
        names?: AuditDirNames | undefined;
      }
    | undefined;
}

export const DEFAULT_HOST = '127.0.0.1';
/**
 * The one address besides loopback the relay binds, and only in hosted mode
 * (S12, ADR 0018). Never ::, which on some platforms also listens on a
 * private network every machine of the account shares.
 */
export const HOSTED_WILDCARD_HOST = '0.0.0.0';
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
/** Long enough to sign in and scan a few codes, short enough that a forgotten phone is soon signed out. */
export const PAIR_SESSION_MS = 15 * 60_000;
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
  pairSessionMs: PAIR_SESSION_MS,
  confirmationTtlMs: CONFIRMATION_TTL_MS,
};

export const DEFAULT_RATE_LIMITS: RelayRateLimits = {
  pairAttemptsPerUser: 10,
  pairAttemptsPerPage: 30,
  pairPreviewsPerNonce: 30,
  pairSignIns: 60,
  callsPerUserPerPage: 120,
  windowMs: 60_000,
  toolsFramesPerSocket: 10,
  toolsFramesPerAddress: 30,
  toolsFramesWindowMs: 10_000,
  ignoredFramesPerSocket: 20,
  ignoredFramesPerAddress: 60,
  connectionLinesPerAddress: 60,
  requestsPerUser: 240,
  requestsPerInvitee: 60,
  redemptionsPerInvite: 30,
  signInsPerAddress: 10,
  auditRefusalsPerUser: 10,
  auditRefusalsForStrangers: 30,
};

export const DEFAULT_LIMITS: RelayLimits = {
  sessionsPerUser: 20,
  sessions: 1000,
  inviteeSessions: 50,
  sessionsPerInvitee: 2,
  usersPerPage: 10,
  queueDepth: 32,
  pageSocketsPerAddress: 20,
  pageSessionsPerAddress: 20,
  pageSessions: 1000,
  pairSessions: 200,
  pairSignInsInFlight: 8,
  signInsInFlightPerAddress: 2,
  // Sized with the image's --max-old-space-size=192 (ADR 0018): charged by
  // heldBytes, which holds above the heap a list really keeps, every hosted
  // page slot filled up to it leaves the relay well inside that heap
  // (tool-heap.test.ts).
  toolBytes: 64 * 1024 * 1024,
  // Sized with the same heap (ADR 0018's notes): charged what a waiting
  // request is measured to hold, set above every shape measured on both legs
  // (ADR 0030), the whole of it filled beside a full tool budget leaves the
  // image's relay serving (call-heap.test.ts), and one member's share holds
  // seven calls of 1 MB string arguments.
  requestBytes: 64 * 1024 * 1024,
  requestBytesPerUser: 24 * 1024 * 1024,
};

/**
 * The least requestBytes and requestBytesPerUser may be: one call of the
 * largest arguments, a 1 MiB string charged for its body and its parsed
 * copy, with room to spare.
 */
export const MIN_REQUEST_BYTES = 4 * MAX_FRAME_BYTES;

/**
 * Hosted mode's defaults where they differ, sized for the reference
 * deployment's 512 MB (ADR 0018); each setting still overrides its own.
 */
export const HOSTED_LIMITS: Readonly<Partial<RelayLimits>> = Object.freeze({
  pageSessions: 100,
  pageSocketsPerAddress: 5,
  pageSessionsPerAddress: 5,
});

/** The ranges a host edge's proxy is trusted from unless TABDOCK_TRUSTED_PROXY_CIDR narrows them: RFC 1918. */
export const DEFAULT_TRUSTED_PROXY_CIDR: readonly string[] = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
];

/** ADR 0019's bounds for the audit files: 30 days, 64 MiB in all, rotation at 8 MiB. */
export const AUDIT_RETENTION_DAYS = 30;
export const AUDIT_MAX_MB = 64;
export const AUDIT_ROTATE_MB = 8;
/** Ten years: past this a retention setting is a typo, not a policy. */
export const MAX_AUDIT_RETENTION_DAYS = 3650;
/** Local mode's audit directory, beside its owner token (ADR 0019, ADR 0022). */
export const LOCAL_AUDIT_DIR = 'audit';

/** What a header-less page socket is recorded as when the dev flag lets it in. */
export const NO_ORIGIN = '(no origin header)';

export interface ResolvedConfig {
  host: string;
  port: number;
  env: RelayEnv;
  /** Whether host names loopback; false only for hosted mode's 0.0.0.0. */
  loopback: boolean;
  /**
   * The public origin in public URL mode, else null. Also the base of the
   * pairing URL a phone opens (M3 QR flow).
   */
  publicUrl: string | null;
  /** `<publicUrl>/mcp`: the URL people add as a connector, and the token audience. */
  publicMcpUrl: string | null;
  /** Host names /mcp and the auth plugin's routes answer to (the DNS rebinding guard). */
  allowedHosts: string[];
  allowMissingOrigin: boolean;
  isOriginAllowed: (origin: string) => boolean;
  /** For the startup log line: the list, or a note that the dev default applies. */
  originPolicy: string;
  /**
   * Whether an Origin header value, exactly as received, may reach /mcp (ADR
   * 0027). A request with no Origin header never asks: the header is a
   * browser's, and Claude Code sends none.
   */
  isMcpOriginAllowed: (origin: string) => boolean;
  /** The /mcp origin policy, as the startup log line names it beside the page one. */
  mcpOriginPolicy: string;
  timings: RelayTimings;
  rateLimits: RelayRateLimits;
  limits: RelayLimits;
  /** The spike's measurements are on (never in production). */
  spike: boolean;
  /** How the relay runs, for its relay_start record (ADR 0019). */
  mode: RelayMode;
  /** Invites are on (ADR 0017): the invitee tier, /i, and minting in the widget. */
  invites: boolean;
  /** First-class page tools are on (ADR 0025). */
  firstClassTools: boolean;
  /** Production with a public URL behind an edge that names the client in clientAddressHeader (ADR 0018). */
  hosted: boolean;
  /** The edge's client address header, lower-cased; null outside hosted mode. */
  clientAddressHeader: string | null;
  /** The ranges the edge is trusted from; empty outside hosted mode. */
  trustedProxies: readonly ProxyRange[];
  audit: ResolvedAudit;
}

const DEV_ORIGIN_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Exactly the three names the SDK's localhostHostValidation accepts in a Host
 * header, so a client that reaches the relay always passes that check.
 */
export function isLoopbackHost(host: string): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host.toLowerCase());
}

const LOOPBACK_ADDRESSES = new BlockList();
LOOPBACK_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK_ADDRESSES.addAddress('::1', 'ipv6');

/**
 * Whether an IP address is a loopback one: 127.0.0.0/8 or ::1, in any IPv6
 * spelling, IPv4-mapped included. isLoopbackHost judges a name, which means
 * whatever the hosts file says; this judges where the relay would listen.
 */
export function isLoopbackAddress(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && LOOPBACK_ADDRESSES.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/** An Origin value must already be in serialised form: scheme, host, optional port, nothing else. */
export function parseOrigin(value: string): string | null {
  const url = URL.parse(value);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null;
  return url.origin === value ? url.origin : null;
}

/**
 * TABDOCK_MCP_ALLOWED_ORIGINS's entries as origins (ADR 0027), each held to
 * parseOrigin's exact form, as page origins are, so an entry with a path, a
 * trailing slash or upper case never matches what a browser sends. A bad
 * entry is named by its place, never echoed, since a token may sit in the
 * wrong variable.
 */
export function parseMcpAllowedOrigins(entries: readonly string[]): string[] {
  return entries.map((entry, index) => {
    const parsed = parseOrigin(entry.trim());
    if (parsed === null) {
      throw new Error(
        `TABDOCK_MCP_ALLOWED_ORIGINS entry ${String(index + 1)} is not an http or https origin written as a browser sends one, such as https://app.example or http://localhost:6274: lower case, no path and no trailing slash (ADR 0027)`,
      );
    }
    return parsed;
  });
}

/** The Host names the SDK's localhost guard accepts, as its own helper lists them. */
export const LOOPBACK_HOSTNAMES: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

/**
 * RFC 9110's Host, uri-host [":" port], narrowed to what clients send: a
 * reg-name of RFC 3986's unreserved characters (a dotted IPv4 address is one),
 * or an IPv6 address in brackets, and a port of one to five digits.
 */
const HOST_HEADER = /^(?<host>[a-z0-9._~-]+|\[(?<ipv6>[0-9a-f:.]+)\])(?::(?<port>\d{1,5}))?$/i;

/**
 * The host a Host header names, lower-cased and without its port, or null
 * when the header is not a host at all. The URL parser is no test of that: it
 * drops userinfo, a path or a fragment and rewrites numeric and
 * percent-encoded forms, so 'evil@localhost' or '2130706433' would read as
 * loopback. Callers compare the result exactly, so only the names as written
 * pass an allowlist.
 */
export function parseHostHeader(header: string): string | null {
  const groups = HOST_HEADER.exec(header)?.groups;
  const host = groups?.host;
  if (host === undefined) return null;
  if (groups?.ipv6 !== undefined && !isIPv6(groups.ipv6)) return null;
  // The adapter rebuilds the request URL from Host, and the URL parser refuses a larger port.
  if (groups?.port !== undefined && Number(groups.port) > 65_535) return null;
  return host.toLowerCase();
}

/**
 * The public URL as an origin (https, no path, no credentials), or an error
 * naming the variable. It is where Claude reaches the relay, so it must be
 * https (S12) and must not name this machine, which would blur the line
 * between local and tunnelled requests that /page relies on.
 */
export function parsePublicUrl(value: string): string {
  const url = URL.parse(value.trim());
  if (url?.protocol !== 'https:') {
    throw new Error(
      'publicUrl (TABDOCK_PUBLIC_URL) must be an https URL such as https://relay.example; the tunnel in front of the relay terminates TLS (SPEC S12, ADR 0014)',
    );
  }
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.pathname !== '/'
  ) {
    throw new Error(
      'publicUrl (TABDOCK_PUBLIC_URL) must be an origin such as https://relay.example, with no path, query or credentials',
    );
  }
  if (isLoopbackHost(url.hostname)) {
    throw new Error(
      'publicUrl (TABDOCK_PUBLIC_URL) names this machine; give the https address the tunnel serves',
    );
  }
  return url.origin;
}

/** The MCP endpoint under a public origin: what people add as a connector. */
export function publicMcpUrlOf(publicOrigin: string): string {
  return new URL('/mcp', publicOrigin).href;
}

/** Where the provider sends a browser back to after sign-in at /pair. */
export function pairRedirectUriOf(publicOrigin: string): string {
  return new URL('/pair/callback', publicOrigin).href;
}

/** OAuth client ids and secrets are opaque but printable (RFC 6749 appendix A); no spaces, so .env trimming cannot change one. */
const CLIENT_ID = /^[\x21-\x7e]{1,255}$/;
const CLIENT_SECRET = /^[\x21-\x7e]{1,1024}$/;

/**
 * The /pair client settings, checked without ever echoing them: the secret
 * belongs in .env, and an id typed into the wrong variable may be one too.
 */
function checkPairClient(pairClient: PairClientOptions): void {
  if (!CLIENT_ID.test(pairClient.clientId)) {
    throw new Error(
      'the /pair client id (TABDOCK_PAIR_CLIENT_ID) must be 1 to 255 printable characters without spaces',
    );
  }
  if (!CLIENT_SECRET.test(pairClient.clientSecret)) {
    throw new Error(
      'the /pair client secret (TABDOCK_PAIR_CLIENT_SECRET) must be 1 to 1024 printable characters without spaces',
    );
  }
}

export function resolveConfig(options: RelayOptions): ResolvedConfig {
  const env = options.env ?? 'development';
  // Checked at run time too: JavaScript callers and env parsing can pass anything.
  if (!(['development', 'production'] as const).includes(env)) {
    throw new Error('env must be development or production');
  }
  // The spike changes what clients see (a sixth tool) and logs every list and
  // stream, which is for measuring, never for serving people (ADR 0014). It is
  // allowed in public URL mode, since hosted Claude is what it measures.
  // Only true turns it on, so a stray value from JavaScript leaves it off.
  const spike = options.spike === true;
  if (spike && env === 'production') {
    throw new Error(
      'spike (TABDOCK_SPIKE) is the M3 spike measurement flag; production refuses to start with it (ADR 0014)',
    );
  }
  // First-class page tools change what members' clients list (ADR 0025), and
  // nothing about who may reach what, so every mode allows them, production
  // included; only true turns them on, so a stray value leaves them off.
  const firstClassTools = options.firstClassTools === true;
  const host = options.host ?? DEFAULT_HOST;
  // ADR 0022: a plugin marked loopbackOnly, local mode's above all, serves
  // this machine and nothing else, whatever its name, so a public URL,
  // production or a wider bind refuses it before any of their own checks.
  // Anything but absent or false counts, so a stray value from JavaScript
  // fails closed.
  const loopbackOnly: unknown = options.auth.loopbackOnly;
  if (loopbackOnly !== undefined && loopbackOnly !== false) {
    const name = `the ${options.auth.name} plugin is marked loopbackOnly: it serves this machine only (local mode, ADR 0022)`;
    if (options.publicUrl !== undefined) {
      throw new Error(
        `${name} and refuses a public URL; public URL mode signs people in through TABDOCK_OAUTH_ISSUER and TABDOCK_OAUTH_USERS`,
      );
    }
    if (env === 'production') {
      throw new Error(
        `${name} and refuses production, which never falls back to local mode; give production its own auth settings`,
      );
    }
    if (!isLoopbackHost(host)) {
      throw new Error(
        `${name} and refuses to bind a host (TABDOCK_HOST) off loopback, the only place it listens`,
      );
    }
    if (options.invites === true) {
      throw new Error(
        `${name} and serves one user, so it mints no invites (TABDOCK_INVITES); invites need dev tokens or a public URL (ADR 0017)`,
      );
    }
  }
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('port must be an integer from 0 to 65535');
  }

  const publicUrl = options.publicUrl === undefined ? null : parsePublicUrl(options.publicUrl);
  const publicMcpUrl = publicUrl === null ? null : publicMcpUrlOf(publicUrl);
  // Only a plugin that checks provider tokens issued for this very address may
  // answer for it; dev tokens never cross a tunnel (ADR 0014).
  if (publicMcpUrl !== null && options.auth.resource !== publicMcpUrl) {
    throw new Error(
      `public URL mode accepts only OAuth sign-in for ${publicMcpUrl}, and the ${options.auth.name} plugin ${options.auth.resource === undefined ? 'checks no provider tokens' : `checks tokens for ${options.auth.resource}`}; set TABDOCK_OAUTH_ISSUER and TABDOCK_OAUTH_USERS (dev tokens are refused in public URL mode)`,
    );
  }
  if (publicMcpUrl === null && options.auth.resource !== undefined) {
    throw new Error(
      `the ${options.auth.name} plugin checks tokens for ${options.auth.resource}, which needs public URL mode (TABDOCK_PUBLIC_URL)`,
    );
  }
  // A public relay is reachable by anyone who learns the address, so it gets
  // the production rules whatever env says.
  const strict = env === 'production' || publicUrl !== null;
  const strictName = env === 'production' ? 'production' : 'public URL mode';

  const allowMissingOrigin = options.allowMissingOrigin ?? false;
  if (allowMissingOrigin && strict) {
    throw new Error(
      `allowMissingOrigin is a development flag; ${strictName} requires an Origin header on every page socket (SPEC S1)`,
    );
  }

  let isOriginAllowed: (origin: string) => boolean;
  let originPolicy: string;
  if (options.allowedOrigins === undefined) {
    if (strict) {
      throw new Error(
        `${strictName} needs an explicit allowedOrigins list (TABDOCK_ALLOWED_ORIGINS); refusing to start (SPEC S2)`,
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
    // A bad entry is named by its place, never echoed, as for /mcp's list:
    // a token may sit in the wrong variable.
    for (const [index, entry] of options.allowedOrigins.entries()) {
      const parsed = parseOrigin(entry.trim());
      if (parsed === null) {
        throw new Error(
          `allowedOrigins (TABDOCK_ALLOWED_ORIGINS) entry ${String(index + 1)} is not an origin such as https://app.example or http://localhost:5173`,
        );
      }
      allowed.add(parsed);
    }
    isOriginAllowed = (origin) => allowed.has(origin);
    originPolicy = [...allowed].join(', ');
  }

  // ADR 0027: /mcp takes loopback origins without a public URL and the public
  // origin with one, compared as written like page origins rather than by
  // hostname as the SDK's guard would, so the public host on another port or
  // over http never passes; and in every mode the listed ones.
  const mcpListed = new Set(parseMcpAllowedOrigins(options.mcpAllowedOrigins ?? []));
  const isMcpOriginAllowed = (origin: string): boolean => {
    if (mcpListed.has(origin)) return true;
    if (publicUrl !== null) return origin === publicUrl;
    const parsed = parseOrigin(origin);
    return parsed !== null && DEV_ORIGIN_HOSTS.has(new URL(parsed).hostname);
  };
  const mcpOriginPolicy = [
    publicUrl ?? 'loopback: http and https on localhost, 127.0.0.1 and [::1]',
    ...mcpListed,
  ].join(', ');

  // The QR page signs phones in at the same provider as the plugin, with a
  // client of the relay's own, so both are needed in public URL mode and the
  // client means nothing without it.
  if (publicUrl !== null) {
    if (options.auth.browserSignIn === undefined) {
      throw new Error(
        `public URL mode serves the QR sign-in at /pair, and the ${options.auth.name} plugin cannot sign a browser in`,
      );
    }
    if (options.pairClient === undefined) {
      throw new Error(
        `public URL mode needs the /pair sign-in client (TABDOCK_PAIR_CLIENT_ID and TABDOCK_PAIR_CLIENT_SECRET), registered at the provider with ${pairRedirectUriOf(publicUrl)} as its redirect URI`,
      );
    }
    checkPairClient(options.pairClient);
  } else if (options.pairClient !== undefined) {
    throw new Error(
      'the /pair sign-in client (TABDOCK_PAIR_CLIENT_ID and TABDOCK_PAIR_CLIENT_SECRET) needs public URL mode (TABDOCK_PUBLIC_URL)',
    );
  }

  // Hosted mode (ADR 0018): only a host edge in front of a production relay
  // with a public URL sets a client address header the relay can believe.
  const clientAddressHeader =
    options.clientAddressHeader === undefined ? null : parseHeaderName(options.clientAddressHeader);
  if (clientAddressHeader !== null && (env !== 'production' || publicUrl === null)) {
    throw new Error(
      'clientAddressHeader (TABDOCK_CLIENT_ADDRESS_HEADER) is for hosted mode only: production (TABDOCK_ENV=production) with a public URL (TABDOCK_PUBLIC_URL), behind a host edge that sets the header (ADR 0018)',
    );
  }
  const hosted = clientAddressHeader !== null;
  if (options.trustedProxyCidr !== undefined && !hosted) {
    throw new Error(
      "trustedProxyCidr (TABDOCK_TRUSTED_PROXY_CIDR) names a host edge's addresses and is for hosted mode only, with TABDOCK_CLIENT_ADDRESS_HEADER (ADR 0018)",
    );
  }
  const trustedProxies = hosted
    ? parseProxyRanges(options.trustedProxyCidr ?? DEFAULT_TRUSTED_PROXY_CIDR)
    : [];
  // S12: a plaintext listener off loopback is safe only behind an edge that
  // terminates TLS and names the client, so hosted mode alone may bind the
  // IPv4 wildcard, and nothing may bind any other address (ADR 0018). The
  // host is not repeated: a token may sit in the wrong variable.
  if (!isLoopbackHost(host) && !(hosted && host === HOSTED_WILDCARD_HOST)) {
    throw new Error(
      hosted
        ? `refusing to bind host (TABDOCK_HOST): hosted mode binds loopback or ${HOSTED_WILDCARD_HOST}, never another address; :: would also listen on a platform's private network (SPEC S12, ADR 0018)`
        : `refusing to bind host (TABDOCK_HOST): the relay listens only on loopback (127.0.0.1, ::1 or localhost) unless it runs in hosted mode, production behind a host edge that terminates TLS and names the client in TABDOCK_CLIENT_ADDRESS_HEADER (SPEC S12, ADR 0018)`,
    );
  }

  // Every timing ends up in a setTimeout, so it must fit one.
  const timings = positiveIntegers(DEFAULT_TIMINGS, options.timings, MAX_TIMER_MS);
  // A call that reached its page is timed for both together.
  if (timings.callDeadlineMs + timings.callDeadlineGraceMs > MAX_TIMER_MS) {
    throw new Error(
      `callDeadlineMs plus callDeadlineGraceMs must be at most ${String(MAX_TIMER_MS)}`,
    );
  }
  // A longer wait would keep a confirmation good past what ADR 0026 allows
  // and hold a 2025-era request open past hosted Claude's 240 s per call.
  if (timings.confirmationTtlMs > CONFIRMATION_TTL_MS) {
    throw new Error(
      `confirmationTtlMs must be at most ${String(CONFIRMATION_TTL_MS)}: a question in a client lives 120 s at most (ADR 0026)`,
    );
  }
  const limits = positiveIntegers(
    hosted ? { ...DEFAULT_LIMITS, ...HOSTED_LIMITS } : DEFAULT_LIMITS,
    options.limits,
  );
  if (limits.toolBytes < MAX_FRAME_BYTES) {
    throw new Error(
      `toolBytes (TABDOCK_MAX_TOOL_BYTES) must be at least ${String(MAX_FRAME_BYTES)}, so the budget holds at least one page of ordinary tools (ADR 0018)`,
    );
  }
  for (const [name, setting] of [
    ['requestBytes', 'TABDOCK_MAX_REQUEST_BYTES'],
    ['requestBytesPerUser', 'TABDOCK_MAX_REQUEST_BYTES_PER_USER'],
  ] as const) {
    if (limits[name] < MIN_REQUEST_BYTES) {
      throw new Error(
        `${name} (${setting}) must be at least ${String(MIN_REQUEST_BYTES)}, so one call of the largest arguments fits (ADR 0018)`,
      );
    }
  }
  // relay.ts answers 413 unparsed only past the share, so a share above the
  // total would let a body charged between the two be parsed, only for the
  // hub to refuse it page_busy.
  if (limits.requestBytesPerUser > limits.requestBytes) {
    throw new Error(
      "requestBytesPerUser (TABDOCK_MAX_REQUEST_BYTES_PER_USER) must be at most requestBytes (TABDOCK_MAX_REQUEST_BYTES): one user's share of what waiting requests hold cannot pass the relay's total, so lower the share with the total (ADR 0030)",
    );
  }
  // Only true turns invites on, so a stray value from JavaScript leaves them off.
  const invites = options.invites === true;
  // Invitees together may hold a quarter of the total or MIN_REQUEST_BYTES,
  // whichever is more, so below twice that floor they could hold more than
  // half of it, and all of it at the least total, leaving members nothing.
  if (invites && limits.requestBytes < 2 * MIN_REQUEST_BYTES) {
    throw new Error(
      `invites (TABDOCK_INVITES) need requestBytes (TABDOCK_MAX_REQUEST_BYTES) of at least ${String(2 * MIN_REQUEST_BYTES)}: invited accounts' requests may hold ${String(MIN_REQUEST_BYTES)} together at the least, and must never hold more than half of the total (ADR 0032)`,
    );
  }
  if (invites && limits.usersPerPage <= MEMBER_RESERVED_SEATS) {
    throw new Error(
      `invites (TABDOCK_INVITES) always leave members ${String(MEMBER_RESERVED_SEATS)} seats of usersPerPage (TABDOCK_MAX_USERS_PER_PAGE), so it must be at least ${String(MEMBER_RESERVED_SEATS + 1)} (ADR 0017)`,
    );
  }
  const mode: RelayMode =
    loopbackOnly !== undefined && loopbackOnly !== false
      ? 'local'
      : hosted
        ? 'hosted'
        : publicUrl !== null
          ? 'public'
          : 'dev_tokens';

  return {
    host,
    port,
    env,
    loopback: isLoopbackHost(host),
    publicUrl,
    publicMcpUrl,
    allowedHosts:
      publicUrl === null
        ? [...LOOPBACK_HOSTNAMES]
        : [...LOOPBACK_HOSTNAMES, new URL(publicUrl).hostname],
    allowMissingOrigin,
    isOriginAllowed,
    originPolicy,
    isMcpOriginAllowed,
    mcpOriginPolicy,
    timings,
    rateLimits: positiveIntegers(DEFAULT_RATE_LIMITS, options.rateLimits),
    limits,
    spike,
    mode,
    invites,
    firstClassTools,
    hosted,
    clientAddressHeader,
    trustedProxies,
    audit: resolveAudit(options.audit),
  };
}

/** HTTP header names are tokens; the relay compares the lower-cased form, as node stores headers. */
const HEADER_NAME = /^[a-z0-9-]{1,64}$/;

function parseHeaderName(value: string): string {
  const name = value.trim().toLowerCase();
  if (!HEADER_NAME.test(name)) {
    throw new Error(
      'clientAddressHeader (TABDOCK_CLIENT_ADDRESS_HEADER) must be one header name of letters, digits and hyphens, such as fly-client-ip',
    );
  }
  return name;
}

/** One `address/prefix` range, IPv4 or IPv6, or null when it is not one. */
export function parseProxyRange(entry: string): ProxyRange | null {
  const parts = entry.trim().split('/');
  const [address, prefixText] = parts;
  if (parts.length !== 2 || address === undefined || prefixText === undefined) return null;
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const family = isIP(address);
  if (family === 0) return null;
  const prefix = Number(prefixText);
  if (prefix > (family === 4 ? 32 : 128)) return null;
  return { address, prefix, family: family === 4 ? 'ipv4' : 'ipv6' };
}

function parseProxyRanges(entries: readonly string[]): ProxyRange[] {
  if (entries.length === 0) {
    throw new Error(
      'trustedProxyCidr (TABDOCK_TRUSTED_PROXY_CIDR) lists no range; leave it unset for the RFC 1918 ranges (ADR 0018)',
    );
  }
  return entries.map((entry, index) => {
    const range = parseProxyRange(entry);
    if (range === null) {
      throw new Error(
        `TABDOCK_TRUSTED_PROXY_CIDR entry ${String(index + 1)} is not an address range such as 10.0.0.0/8 or fdaa::/16`,
      );
    }
    return range;
  });
}

/** The audit log's settings, checked; the bounds mean nothing without a directory to bound. */
function resolveAudit(audit: RelayOptions['audit']): ResolvedAudit {
  const dir = audit?.dir;
  if (dir !== undefined && !isAbsolute(dir)) {
    throw new Error('the audit directory (TABDOCK_AUDIT_DIR) must be an absolute path');
  }
  const retentionDays = audit?.retentionDays;
  const maxMb = audit?.maxMb;
  if (dir === undefined) {
    if (retentionDays !== undefined) {
      throw new Error(
        'auditRetentionDays (TABDOCK_AUDIT_RETENTION_DAYS) bounds the audit files, and without an audit directory (TABDOCK_AUDIT_DIR) the relay keeps none (ADR 0019)',
      );
    }
    if (maxMb !== undefined) {
      throw new Error(
        'auditMaxMb (TABDOCK_AUDIT_MAX_MB) bounds the audit files, and without an audit directory (TABDOCK_AUDIT_DIR) the relay keeps none (ADR 0019)',
      );
    }
  }
  if (
    retentionDays !== undefined &&
    (!Number.isInteger(retentionDays) ||
      retentionDays < 1 ||
      retentionDays > MAX_AUDIT_RETENTION_DAYS)
  ) {
    throw new Error(
      `auditRetentionDays (TABDOCK_AUDIT_RETENTION_DAYS) must be 1 to ${String(MAX_AUDIT_RETENTION_DAYS)} days`,
    );
  }
  if (
    maxMb !== undefined &&
    (!Number.isInteger(maxMb) || maxMb < AUDIT_ROTATE_MB || maxMb > 1024 * 1024)
  ) {
    throw new Error(
      `auditMaxMb (TABDOCK_AUDIT_MAX_MB) must be ${String(AUDIT_ROTATE_MB)} to ${String(1024 * 1024)} MiB, ${String(AUDIT_ROTATE_MB)} being the size at which a file rotates`,
    );
  }
  return {
    dir: dir ?? null,
    names: audit?.names ?? null,
    retentionDays: retentionDays ?? AUDIT_RETENTION_DAYS,
    maxBytes: (maxMb ?? AUDIT_MAX_MB) * 1024 * 1024,
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
 * Any of these, set and not blank, takes the relay out of local mode (ADR
 * 0022): explicit settings always win.
 */
export const AUTH_SETTINGS: readonly string[] = [
  'TABDOCK_DEV_TOKENS',
  'TABDOCK_PUBLIC_URL',
  'TABDOCK_OAUTH_ISSUER',
  'TABDOCK_OAUTH_USERS',
  'TABDOCK_PAIR_CLIENT_ID',
  'TABDOCK_PAIR_CLIENT_SECRET',
];

/** What local mode tells the banner; the token itself never leaves loadConfigFromEnv. */
export interface LocalModeInfo {
  /** The owner token's file, which the printed command reads. */
  tokenPath: string;
  /** How refusals name the token directory and what lies in or above it (PathNames). */
  names: PathNames;
  /** Whether this start drew the token. */
  created: boolean;
}

/** The relay's options from the environment, and in local mode what the banner prints. */
export interface EnvConfig extends RelayOptions {
  localMode?: LocalModeInfo | undefined;
}

interface EnvAuth {
  auth: AuthPlugin;
  publicUrl?: string;
  pairClient?: PairClientOptions;
  localMode?: LocalModeInfo;
}

/**
 * The auth plugin the environment asks for. TABDOCK_PUBLIC_URL means OAuth
 * through TABDOCK_OAUTH_ISSUER for the people in TABDOCK_OAUTH_USERS, and
 * TABDOCK_DEV_TOKENS is then ignored (ADR 0014); without it, dev tokens as in
 * M1. The OAuth settings alone mean nothing, since tokens are issued for the
 * public URL, so they are refused rather than silently unused. With none of
 * AUTH_SETTINGS the relay runs in local mode outside production (ADR 0022);
 * production without them refuses to start.
 */
function authFromEnv(
  env: NodeJS.ProcessEnv,
  envName: RelayEnv,
  host: string | undefined,
  invites: boolean,
  system: Partial<LocalTokenSystem>,
): EnvAuth {
  const publicText = env.TABDOCK_PUBLIC_URL?.trim() ?? '';
  const issuer = env.TABDOCK_OAUTH_ISSUER?.trim() ?? '';
  const oauthUsers = env.TABDOCK_OAUTH_USERS?.trim() ?? '';
  const pairClientId = env.TABDOCK_PAIR_CLIENT_ID?.trim() ?? '';
  const pairClientSecret = env.TABDOCK_PAIR_CLIENT_SECRET?.trim() ?? '';
  if (publicText !== '') {
    if (issuer === '' || oauthUsers === '') {
      throw new Error(
        'TABDOCK_PUBLIC_URL needs TABDOCK_OAUTH_ISSUER and TABDOCK_OAUTH_USERS: a relay with a public URL signs people in only through OAuth (ADR 0014)',
      );
    }
    const publicUrl = parsePublicUrl(publicText);
    const clientIds = env.TABDOCK_OAUTH_CLIENT_IDS?.trim() ?? '';
    const auth = createOAuthAuth({
      issuer,
      resource: publicMcpUrlOf(publicUrl),
      users: parseOAuthUsers(oauthUsers),
      maxTokenAgeMinutes: parseCount(
        'TABDOCK_OAUTH_MAX_TOKEN_AGE',
        env.TABDOCK_OAUTH_MAX_TOKEN_AGE,
      ),
      clientIds: clientIds === '' ? undefined : parseOAuthClientIds(clientIds),
    });
    if (pairClientId === '' || pairClientSecret === '') {
      throw new Error(
        'TABDOCK_PUBLIC_URL needs TABDOCK_PAIR_CLIENT_ID and TABDOCK_PAIR_CLIENT_SECRET: the client the QR page at /pair signs phones in with',
      );
    }
    return {
      auth,
      publicUrl,
      pairClient: { clientId: pairClientId, clientSecret: pairClientSecret },
    };
  }
  if (issuer !== '' || oauthUsers !== '') {
    throw new Error(
      'TABDOCK_OAUTH_ISSUER and TABDOCK_OAUTH_USERS work only with TABDOCK_PUBLIC_URL, the https address tokens are issued for (ADR 0014)',
    );
  }
  if (pairClientId !== '' || pairClientSecret !== '') {
    throw new Error(
      'TABDOCK_PAIR_CLIENT_ID and TABDOCK_PAIR_CLIENT_SECRET work only with TABDOCK_PUBLIC_URL, where the QR page signs phones in',
    );
  }
  const tokens = env.TABDOCK_DEV_TOKENS?.trim() ?? '';
  if (tokens !== '') {
    const users = parseDevTokens(tokens);
    // An invitee entry means nothing while the relay admits no invitees (ADR 0017).
    const invitee = users.findIndex((user) => user.kind === 'invitee');
    if (invitee !== -1 && !invites) {
      throw new Error(
        `TABDOCK_DEV_TOKENS entry ${String(invitee + 1)} names an invitee (a g_ user id), and there are none unless TABDOCK_INVITES is on (ADR 0017)`,
      );
    }
    return { auth: createDevTokenAuth(users) };
  }
  if (envName === 'production') {
    throw new Error(
      'production needs auth settings, such as TABDOCK_PUBLIC_URL with TABDOCK_OAUTH_ISSUER and TABDOCK_OAUTH_USERS; it never falls back to local mode, which serves only this machine (ADR 0022)',
    );
  }
  // Refused here as resolveConfig would, but before a token is drawn for a relay that cannot start.
  if (host !== undefined && !isLoopbackHost(host)) {
    throw new Error(
      'local mode listens only on loopback and refuses a TABDOCK_HOST off it; leave TABDOCK_HOST unset or use 127.0.0.1, ::1 or localhost (ADR 0022)',
    );
  }
  const owner = loadOwnerToken(env, system);
  // Lock and audit refusals name the directory as the owner token's did.
  const names = pathNames(env, system);
  return {
    // The token directory stays locked while the relay runs, whatever its
    // audit directory, so no second relay serves this token beside it and no
    // --new-token replaces it under a relay still taking the old one.
    auth: holdingTokenLock(
      createDevTokenAuth([{ ...LOCAL_USER, token: owner.token }], { loopbackOnly: true }),
      dirname(owner.path),
      (path) => names.of(path),
    ),
    localMode: { tokenPath: owner.path, names, created: owner.created },
  };
}

/**
 * M4's settings that mean something in one mode only, each refused by name
 * elsewhere (ADR 0022) rather than silently unused, and before local mode
 * draws a token for a relay that cannot start. resolveConfig checks the same
 * rules again for options given in code.
 */
function refuseSettingsOutOfMode(
  env: NodeJS.ProcessEnv,
  relayEnv: RelayEnv,
  invites: boolean,
): void {
  const isSet = (name: string): boolean => (env[name]?.trim() ?? '') !== '';
  const publicMode = isSet('TABDOCK_PUBLIC_URL');
  const localMode = !AUTH_SETTINGS.some(isSet) && relayEnv !== 'production';
  for (const name of ['TABDOCK_OAUTH_MAX_TOKEN_AGE', 'TABDOCK_OAUTH_CLIENT_IDS']) {
    if (isSet(name) && !publicMode) {
      throw new Error(
        `${name} tunes OAuth sign-in, which only public URL mode uses (TABDOCK_PUBLIC_URL with TABDOCK_OAUTH_ISSUER); refusing a setting that would mean nothing (ADR 0020)`,
      );
    }
  }
  const hostedMode = publicMode && relayEnv === 'production';
  if (isSet('TABDOCK_CLIENT_ADDRESS_HEADER') && !hostedMode) {
    throw new Error(
      'TABDOCK_CLIENT_ADDRESS_HEADER is for hosted mode only: TABDOCK_ENV=production with TABDOCK_PUBLIC_URL, behind a host edge that sets the header (ADR 0018)',
    );
  }
  if (isSet('TABDOCK_TRUSTED_PROXY_CIDR') && !isSet('TABDOCK_CLIENT_ADDRESS_HEADER')) {
    throw new Error(
      "TABDOCK_TRUSTED_PROXY_CIDR names a host edge's addresses and is for hosted mode only, with TABDOCK_CLIENT_ADDRESS_HEADER (ADR 0018)",
    );
  }
  if (invites && localMode) {
    throw new Error(
      'TABDOCK_INVITES does not apply to local mode, which serves one user and mints no invites; invites need dev tokens or a public URL (ADR 0017)',
    );
  }
  if (isSet('TABDOCK_MAX_REQUESTS_PER_INVITEE') && !invites) {
    throw new Error(
      'TABDOCK_MAX_REQUESTS_PER_INVITEE limits invitees, and there are none unless TABDOCK_INVITES is on (ADR 0018)',
    );
  }
  for (const name of ['TABDOCK_AUDIT_RETENTION_DAYS', 'TABDOCK_AUDIT_MAX_MB']) {
    if (isSet(name) && !isSet('TABDOCK_AUDIT_DIR') && !localMode) {
      throw new Error(
        `${name} bounds the audit files, and without TABDOCK_AUDIT_DIR, or local mode's directory beside its token, the relay keeps none (ADR 0019)`,
      );
    }
  }
}

/**
 * How refusals name the audit directory when the environment gave it: a
 * TABDOCK_AUDIT_DIR value, an absolute path that may still be a token pasted
 * into the wrong variable, by the variable alone, as the audit reader names
 * it (ADR 0028); local mode's directory beside its owner token as the token
 * directory is named, from TABDOCK_HOME when that setting gave it (PathNames).
 * Each phrase follows "the audit directory".
 */
function auditDirNames(
  besideToken: string | undefined,
  localMode: LocalModeInfo | undefined,
): AuditDirNames {
  const withCode = (named: string, code: string | undefined): string =>
    code === undefined ? named : `${named} (${code})`;
  if (besideToken === undefined || localMode === undefined) {
    return {
      dir: (code) => withCode('TABDOCK_AUDIT_DIR gives', code),
      file: (path) => `${basename(path)} in the audit directory TABDOCK_AUDIT_DIR gives`,
    };
  }
  const { names } = localMode;
  return {
    dir: (code) => withCode(names.fromSetting ? `in ${GIVEN_HOME}` : besideToken, code),
    file: (path) => names.of(path),
  };
}

/**
 * Reads the relay's settings from the environment (normally process.env after
 * the repo-root .env is loaded). Auth comes from TABDOCK_DEV_TOKENS, from the
 * OAuth settings in public URL mode, or, with neither, from local mode's owner
 * token, which this reads or draws (ADR 0022); `system` stands in for the
 * platform, account and home directory in tests. Errors name the variable,
 * never its value, since a token may sit in the wrong place.
 */
export function loadConfigFromEnv(
  env: NodeJS.ProcessEnv,
  system: Partial<LocalTokenSystem> = {},
): EnvConfig {
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

  // Parsed like TABDOCK_ALLOWED_ORIGINS, and checked here as well, so a bad
  // entry stops the relay before local mode draws a token.
  const mcpOriginsText = env.TABDOCK_MCP_ALLOWED_ORIGINS?.trim() ?? '';
  const mcpAllowedOrigins =
    mcpOriginsText === ''
      ? undefined
      : parseMcpAllowedOrigins(
          mcpOriginsText
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
        );

  const hostText = env.TABDOCK_HOST?.trim() ?? '';
  const host = hostText === '' ? undefined : hostText;
  const relayEnv: RelayEnv = envName === '' ? 'development' : envName;
  const allowMissingOrigin = parseFlag(
    'TABDOCK_DEV_ALLOW_NO_ORIGIN',
    env.TABDOCK_DEV_ALLOW_NO_ORIGIN,
  );
  const spike = parseFlag('TABDOCK_SPIKE', env.TABDOCK_SPIKE);
  const timings = {
    sessionIdleMs: parseMinutes('TABDOCK_SESSION_IDLE_MINUTES', env.TABDOCK_SESSION_IDLE_MINUTES),
    attachmentIdleMs: parseMinutes(
      'TABDOCK_ATTACHMENT_IDLE_MINUTES',
      env.TABDOCK_ATTACHMENT_IDLE_MINUTES,
    ),
  };
  const rateLimits = {
    callsPerUserPerPage: parseCount(
      'TABDOCK_MAX_CALLS_PER_MINUTE',
      env.TABDOCK_MAX_CALLS_PER_MINUTE,
    ),
    pairSignIns: parseCount(
      'TABDOCK_MAX_PAIR_SIGNINS_PER_MINUTE',
      env.TABDOCK_MAX_PAIR_SIGNINS_PER_MINUTE,
    ),
    requestsPerUser: parseCount('TABDOCK_MAX_REQUESTS_PER_USER', env.TABDOCK_MAX_REQUESTS_PER_USER),
    requestsPerInvitee: parseCount(
      'TABDOCK_MAX_REQUESTS_PER_INVITEE',
      env.TABDOCK_MAX_REQUESTS_PER_INVITEE,
    ),
  };
  const limits = {
    sessionsPerUser: parseCount('TABDOCK_MAX_SESSIONS_PER_USER', env.TABDOCK_MAX_SESSIONS_PER_USER),
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
    pairSignInsInFlight: parseCount(
      'TABDOCK_MAX_PAIR_SIGNINS_IN_FLIGHT',
      env.TABDOCK_MAX_PAIR_SIGNINS_IN_FLIGHT,
    ),
    toolBytes: parseCount('TABDOCK_MAX_TOOL_BYTES', env.TABDOCK_MAX_TOOL_BYTES),
    requestBytes: parseCount('TABDOCK_MAX_REQUEST_BYTES', env.TABDOCK_MAX_REQUEST_BYTES),
    requestBytesPerUser: parseCount(
      'TABDOCK_MAX_REQUEST_BYTES_PER_USER',
      env.TABDOCK_MAX_REQUEST_BYTES_PER_USER,
    ),
  };
  const invites = parseFlag('TABDOCK_INVITES', env.TABDOCK_INVITES);
  const firstClassTools = parseFlag('TABDOCK_FIRST_CLASS_TOOLS', env.TABDOCK_FIRST_CLASS_TOOLS);
  const headerText = env.TABDOCK_CLIENT_ADDRESS_HEADER?.trim() ?? '';
  const cidrText = env.TABDOCK_TRUSTED_PROXY_CIDR?.trim() ?? '';
  const auditDirText = env.TABDOCK_AUDIT_DIR?.trim() ?? '';
  const retentionDays = parseCount(
    'TABDOCK_AUDIT_RETENTION_DAYS',
    env.TABDOCK_AUDIT_RETENTION_DAYS,
  );
  const maxMb = parseCount('TABDOCK_AUDIT_MAX_MB', env.TABDOCK_AUDIT_MAX_MB);
  refuseSettingsOutOfMode(env, relayEnv, invites);

  // Last, so a mistake in any other setting is reported before local mode draws a token.
  const { auth, publicUrl, pairClient, localMode } = authFromEnv(
    env,
    relayEnv,
    host,
    invites,
    system,
  );
  // Local mode keeps its audit files beside its owner token unless told otherwise (ADR 0019).
  const besideToken =
    auditDirText === '' && localMode !== undefined
      ? join(dirname(localMode.tokenPath), LOCAL_AUDIT_DIR)
      : undefined;
  const auditDir = auditDirText !== '' ? auditDirText : besideToken;
  const audit = {
    dir: auditDir,
    retentionDays,
    maxMb,
    names: auditDirNames(besideToken, localMode),
  };
  return {
    auth,
    publicUrl,
    pairClient,
    localMode,
    host,
    port,
    env: relayEnv,
    allowedOrigins,
    allowMissingOrigin,
    mcpAllowedOrigins,
    spike,
    timings,
    rateLimits,
    limits,
    invites,
    firstClassTools,
    clientAddressHeader: headerText === '' ? undefined : headerText,
    trustedProxyCidr:
      cidrText === ''
        ? undefined
        : cidrText
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
    audit,
  };
}

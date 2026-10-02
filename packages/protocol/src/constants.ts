// Fixed numbers from SPEC.md sections 5, 6 and 9, plus the M1 choices recorded in
// docs/plans/M1.md and ADR 0005. Relay and adapter both import them, so the two
// sides can never disagree.

/** WebSocket subprotocol for the page link. */
export const SUBPROTOCOL = 'tabdock.v1';

/** Version number carried in the hello frame. */
export const PROTOCOL_VERSION = 1;

/** Largest page link frame either side accepts, in bytes. */
export const MAX_FRAME_BYTES = 1024 * 1024;

/** Tool results longer than this many characters are truncated with a visible marker. */
export const MAX_RESULT_CHARS = 120_000;

/** Page-supplied tool descriptions are cut to this length before any client sees them (S10). */
export const MAX_DESCRIPTION_CHARS = 1000;

/** Most tools one page may publish. */
export const MAX_TOOLS_PER_PAGE = 128;

/** The relay pings every 15 s and drops a socket after 30 s of silence. */
export const PING_INTERVAL_MS = 15_000;
export const IDLE_TIMEOUT_MS = 30_000;

/** An asleep page keeps its attachments for this long before it is gone. */
export const RESUME_WINDOW_MS = 10 * 60_000;

/** A pairing code lives this long and works once. */
export const PAIRING_TTL_MS = 120_000;

/** An attach request waits this long for the operator; silence means deny. */
export const ATTACH_REQUEST_TTL_MS = 60_000;

/**
 * pair_page waits at most this long, under the 60 s first-byte timer Claude Code
 * applies to HTTP tool calls (ADR 0005). The request itself stays open on the page
 * for the full ATTACH_REQUEST_TTL_MS.
 */
export const PAIR_WAIT_MS = 50_000;

/** Default time a page gets to answer one call. */
export const DEFAULT_CALL_DEADLINE_MS = 45_000;

/** The adapter re-reads the tool list this often in case toolchange never fires. */
export const TOOL_POLL_MS = 2000;

/** Reconnect backoff bounds for the adapter. */
export const RECONNECT_MIN_MS = 500;
export const RECONNECT_MAX_MS = 30_000;

/**
 * Close codes on the page link beyond the standard ones (1001 idle or shutdown,
 * 1008 malformed frame, 1009 frame too large). Browsers let page code send only
 * 1000 and 3000 to 4999, so the page's own code sits in that range.
 */
/** The page detached on purpose; the relay ends its session at once instead of keeping it asleep. */
export const CLOSE_DETACH = 4000;
/** A newer socket resumed this page's session; the old socket must not reconnect. */
export const CLOSE_REPLACED = 4001;
